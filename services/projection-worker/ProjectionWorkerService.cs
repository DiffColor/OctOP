using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using NATS.Client;
using Newtonsoft.Json.Linq;
using RethinkDb.Driver;
using RethinkConnection = RethinkDb.Driver.Net.Connection;

namespace OctOP.ProjectionWorker;

public sealed class ProjectionWorkerService : BackgroundService
{
  private const string OctopUserTable = "users";
  private const string BridgeNodeTable = "bridge_nodes";
  private const string ProjectTable = "projects";
  private const string ProjectMemberTable = "project_members";
  private const string UserTable = "bridge_user_state";
  private const string ThreadTable = "thread_projection";
  private const string EventTable = "event_log";

  private readonly ILogger<ProjectionWorkerService> _logger;
  private readonly string _natsUrl;
  private readonly string _rethinkHost;
  private readonly int _rethinkPort;
  private readonly string _rethinkDb;
  private readonly string _rethinkUser;
  private readonly string _rethinkPassword;
  private readonly RethinkDB _r = RethinkDB.R;

  public ProjectionWorkerService(ILogger<ProjectionWorkerService> logger)
  {
    _logger = logger;
    _natsUrl = Environment.GetEnvironmentVariable("OCTOP_NATS_URL") ?? "nats://ilysrv.ddns.net:4222";
    _rethinkHost = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_HOST") ?? "rethinkdb.ilycode.app";
    _rethinkPort = int.TryParse(Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_PORT"), out var port)
      ? port
      : 28015;
    _rethinkDb = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_DB") ?? "OctOP";
    _rethinkUser = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_USER") ?? string.Empty;
    _rethinkPassword = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_PASSWORD") ?? string.Empty;
  }

  protected override async Task ExecuteAsync(CancellationToken stoppingToken)
  {
    var natsOptions = ConnectionFactory.GetDefaultOptions();
    natsOptions.Url = _natsUrl;

    using var nats = new ConnectionFactory().CreateConnection(natsOptions);
    using var connection = await _r.Connection()
      .Hostname(_rethinkHost)
      .Port(_rethinkPort)
      .Db(_rethinkDb)
      .User(_rethinkUser, _rethinkPassword)
      .ConnectAsync();

    await EnsureStorageAsync(connection);

    using var subscription = nats.SubscribeAsync("octop.user.*.bridge.*.events");
    subscription.MessageHandler += (_, args) =>
    {
      var payload = Encoding.UTF8.GetString(args.Message.Data ?? []);
      _ = Task.Run(() => HandleEventAsync(connection, payload, stoppingToken), stoppingToken);
    };
    subscription.Start();

    _logger.LogInformation(
      "OctOP projection worker connected to NATS {NatsUrl} and RethinkDB {Host}:{Port}/{Db}",
      _natsUrl,
      _rethinkHost,
      _rethinkPort,
      _rethinkDb
    );

    try
    {
      await Task.Delay(Timeout.InfiniteTimeSpan, stoppingToken);
    }
    catch (OperationCanceledException)
    {
    }
  }

  private async Task EnsureStorageAsync(RethinkConnection connection)
  {
    var dbs = await _r.DbList().RunResultAsync<List<string>>(connection);

    if (!dbs.Contains(_rethinkDb))
    {
      await _r.DbCreate(_rethinkDb).RunResultAsync<object>(connection);
    }

    var tables = await _r.Db(_rethinkDb).TableList().RunResultAsync<List<string>>(connection);

    await EnsureTableAsync(connection, tables, OctopUserTable);
    await EnsureTableAsync(connection, tables, BridgeNodeTable);
    await EnsureTableAsync(connection, tables, ProjectTable);
    await EnsureTableAsync(connection, tables, ProjectMemberTable);
    await EnsureTableAsync(connection, tables, UserTable);
    await EnsureTableAsync(connection, tables, ThreadTable);
    await EnsureTableAsync(connection, tables, EventTable);
  }

  private async Task HandleEventAsync(RethinkConnection connection, string payload, CancellationToken stoppingToken)
  {
    try
    {
      var @event = JObject.Parse(payload);
      await PersistEventAsync(connection, @event);
      await UpsertBridgeNodeAsync(connection, @event);
      await UpsertProjectsAsync(connection, @event);
      await UpsertUserStateAsync(connection, @event);
      await UpsertThreadProjectionAsync(connection, @event);
    }
    catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
    {
      _logger.LogError(exception, "Projection worker failed to persist event payload");
    }
  }

  private async Task EnsureTableAsync(RethinkConnection connection, IReadOnlyCollection<string> tables, string tableName)
  {
    if (!tables.Contains(tableName))
    {
      await _r.Db(_rethinkDb).TableCreate(tableName).RunResultAsync<object>(connection);
    }
  }

  private async Task PersistEventAsync(RethinkConnection connection, JObject @event)
  {
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var type = @event.Value<string>("type") ?? "unknown";
    @event["id"] = $"{loginId}-{timestamp}-{type}".Replace(".", "_").Replace("/", "_").Replace(":", "_");

    await _r.Db(_rethinkDb)
      .Table(EventTable)
      .Insert(@event)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private async Task UpsertUserStateAsync(RethinkConnection connection, JObject @event)
  {
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var current = await _r.Db(_rethinkDb).Table(UserTable).Get(loginId).RunResultAsync<JObject?>(connection) ?? new JObject
    {
      ["id"] = loginId,
      ["login_id"] = loginId,
      ["projects"] = new JArray(),
      ["threads"] = new JArray(),
      ["last_event_type"] = string.Empty,
      ["updated_at"] = timestamp
    };

    current["last_event_type"] = @event.Value<string>("type") ?? string.Empty;
    current["updated_at"] = timestamp;

    if ((string?)@event["type"] == "bridge.status.updated")
    {
      current["status"] = @event["payload"];
    }

    if ((string?)@event["type"] == "bridge.projects.updated")
    {
      current["projects"] = @event["payload"]?["projects"] ?? new JArray();
    }

    if ((string?)@event["type"] == "bridge.threads.updated")
    {
      current["threads"] = @event["payload"]?["threads"] ?? new JArray();
    }

    await _r.Db(_rethinkDb)
      .Table(UserTable)
      .Insert(current)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private async Task UpsertBridgeNodeAsync(RethinkConnection connection, JObject @event)
  {
    var bridgeId = @event.Value<string>("bridge_id");

    if (string.IsNullOrWhiteSpace(bridgeId))
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var existing = await _r.Db(_rethinkDb)
      .Table(BridgeNodeTable)
      .Get(bridgeId)
      .RunResultAsync<JObject?>(connection) ?? new JObject
      {
        ["id"] = bridgeId,
        ["bridge_id"] = bridgeId,
        ["login_id"] = loginId,
        ["user_id"] = loginId,
        ["device_name"] = @event.Value<string>("device_name") ?? bridgeId,
        ["status"] = "unknown",
        ["created_at"] = timestamp
      };

    existing["login_id"] = loginId;
    existing["user_id"] = loginId;
    existing["device_name"] = @event.Value<string>("device_name") ?? existing.Value<string>("device_name") ?? bridgeId;
    existing["last_event_type"] = @event.Value<string>("type") ?? string.Empty;
    existing["last_seen_at"] = timestamp;

    if ((string?)@event["type"] == "bridge.status.updated")
    {
      existing["status"] = "online";
      existing["runtime"] = @event["payload"];
    }

    await _r.Db(_rethinkDb)
      .Table(BridgeNodeTable)
      .Insert(existing)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private async Task UpsertProjectsAsync(RethinkConnection connection, JObject @event)
  {
    if ((string?)@event["type"] != "bridge.projects.updated")
    {
      return;
    }

    var projects = @event["payload"]?["projects"] as JArray;

    if (projects is null || projects.Count == 0)
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var bridgeId = @event.Value<string>("bridge_id") ?? "unknown-bridge";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");

    foreach (var token in projects.OfType<JObject>())
    {
      var projectId = token.Value<string>("id");

      if (string.IsNullOrWhiteSpace(projectId))
      {
        continue;
      }

      token["bridge_id"] = bridgeId;
      token["updated_at"] = timestamp;
      token["owner_login_id"] = loginId;
      token["owner_user_id"] = loginId;

      await _r.Db(_rethinkDb)
        .Table(ProjectTable)
        .Insert(token)
        .OptArg("conflict", "update")
        .RunResultAsync<object>(connection);

      var membership = new JObject
      {
        ["id"] = $"{loginId}:{projectId}",
        ["login_id"] = loginId,
        ["user_id"] = loginId,
        ["project_id"] = projectId,
        ["bridge_id"] = bridgeId,
        ["role"] = "owner",
        ["updated_at"] = timestamp
      };

      await _r.Db(_rethinkDb)
        .Table(ProjectMemberTable)
        .Insert(membership)
        .OptArg("conflict", "replace")
        .RunResultAsync<object>(connection);
    }
  }

  private async Task UpsertThreadProjectionAsync(RethinkConnection connection, JObject @event)
  {
    var thread = @event["payload"]?["thread"] as JObject;

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var eventType = @event.Value<string>("type");
    var projectedAt = @event.Value<string>("timestamp");

    if (thread?["id"] is not null)
    {
      thread["login_id"] = loginId;
      thread["user_id"] = loginId;
      thread["bridge_id"] = bridgeId;
      thread["last_event_type"] = eventType;
      thread["projected_at"] = projectedAt;
      await UpsertThreadDocumentAsync(connection, thread, projectedAt);
    }

    if (eventType != "bridge.threads.updated")
    {
      return;
    }

    var threads = @event["payload"]?["threads"] as JArray;

    if (threads is null)
    {
      return;
    }

    foreach (var item in threads.OfType<JObject>())
    {
      if (item["id"] is null)
      {
        continue;
      }

      item["login_id"] = loginId;
      item["user_id"] = loginId;
      item["bridge_id"] = bridgeId;
      item["last_event_type"] = eventType;
      item["projected_at"] = projectedAt;
      await UpsertThreadDocumentAsync(connection, item, projectedAt);
    }
  }

  private async Task UpsertThreadDocumentAsync(RethinkConnection connection, JObject thread, string? projectedAt)
  {
    var threadId = thread.Value<string>("id");

    if (string.IsNullOrWhiteSpace(threadId))
    {
      return;
    }

    var existing = await _r.Db(_rethinkDb)
      .Table(ThreadTable)
      .Get(threadId)
      .RunResultAsync<JObject?>(connection);

    if (!ShouldReplaceThreadProjection(existing, projectedAt))
    {
      return;
    }

    PreserveTerminalStatus(existing, thread);

    await _r.Db(_rethinkDb)
      .Table(ThreadTable)
      .Insert(thread)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private static bool ShouldReplaceThreadProjection(JObject? existing, string? incomingProjectedAt)
  {
    if (existing is null)
    {
      return true;
    }

    var existingProjectedAt = existing.Value<string>("projected_at");

    if (!DateTimeOffset.TryParse(existingProjectedAt, out var existingTime))
    {
      return true;
    }

    if (!DateTimeOffset.TryParse(incomingProjectedAt, out var incomingTime))
    {
      return true;
    }

    return incomingTime >= existingTime;
  }

  private static void PreserveTerminalStatus(JObject? existing, JObject incoming)
  {
    if (existing is null)
    {
      return;
    }

    var existingStatus = existing.Value<string>("status");
    var incomingStatus = incoming.Value<string>("status");

    if (!IsTerminalStatus(existingStatus) || IsTerminalStatus(incomingStatus))
    {
      return;
    }

    incoming["status"] = existingStatus;
    incoming["progress"] = existing["progress"] ?? 100;
    incoming["last_event"] = existing["last_event"] ?? incoming["last_event"];
    incoming["last_event_type"] = existing["last_event_type"] ?? incoming["last_event_type"];
    incoming["updated_at"] = existing["updated_at"] ?? incoming["updated_at"];
  }

  private static bool IsTerminalStatus(string? status)
  {
    return string.Equals(status, "completed", StringComparison.OrdinalIgnoreCase) ||
           string.Equals(status, "failed", StringComparison.OrdinalIgnoreCase);
  }
}
