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

    using var subscription = nats.SubscribeAsync("octop.user.*.events");
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

    if (!tables.Contains(UserTable))
    {
      await _r.Db(_rethinkDb).TableCreate(UserTable).RunResultAsync<object>(connection);
    }

    if (!tables.Contains(ThreadTable))
    {
      await _r.Db(_rethinkDb).TableCreate(ThreadTable).RunResultAsync<object>(connection);
    }

    if (!tables.Contains(EventTable))
    {
      await _r.Db(_rethinkDb).TableCreate(EventTable).RunResultAsync<object>(connection);
    }
  }

  private async Task HandleEventAsync(RethinkConnection connection, string payload, CancellationToken stoppingToken)
  {
    try
    {
      var @event = JObject.Parse(payload);
      await PersistEventAsync(connection, @event);
      await UpsertUserStateAsync(connection, @event);
      await UpsertThreadProjectionAsync(connection, @event);
    }
    catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
    {
      _logger.LogError(exception, "Projection worker failed to persist event payload");
    }
  }

  private async Task PersistEventAsync(RethinkConnection connection, JObject @event)
  {
    var userId = @event.Value<string>("user_id") ?? "unknown-user";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var type = @event.Value<string>("type") ?? "unknown";
    @event["id"] = $"{userId}-{timestamp}-{type}".Replace(".", "_").Replace("/", "_").Replace(":", "_");

    await _r.Db(_rethinkDb)
      .Table(EventTable)
      .Insert(@event)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private async Task UpsertUserStateAsync(RethinkConnection connection, JObject @event)
  {
    var userId = @event.Value<string>("user_id") ?? "unknown-user";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var current = await _r.Db(_rethinkDb).Table(UserTable).Get(userId).RunResultAsync<JObject?>(connection) ?? new JObject
    {
      ["id"] = userId,
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

  private async Task UpsertThreadProjectionAsync(RethinkConnection connection, JObject @event)
  {
    var thread = @event["payload"]?["thread"] as JObject;

    if (thread?["id"] is null)
    {
      return;
    }

    thread["user_id"] = @event.Value<string>("user_id");
    thread["last_event_type"] = @event.Value<string>("type");
    thread["projected_at"] = @event.Value<string>("timestamp");

    await _r.Db(_rethinkDb)
      .Table(ThreadTable)
      .Insert(thread)
      .OptArg("conflict", "update")
      .RunResultAsync<object>(connection);
  }
}
