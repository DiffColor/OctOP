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
  private const string ProjectThreadTable = "project_threads";
  private const string ThreadIssueCardTable = "thread_issue_cards";
  private const string RootThreadTable = "root_threads";
  private const string PhysicalThreadTable = "physical_threads";
  private const string HandoffSummaryTable = "handoff_summaries";
  private const string LogicalThreadTimelineTable = "logical_thread_timeline";
  private const string LogicalThreadIssueBoardTable = "logical_thread_issue_board";
  private const string EventTable = "event_log";
  private const string TodoChatTable = "todo_chats";
  private const string TodoMessageTable = "todo_messages";

  private readonly ILogger<ProjectionWorkerService> _logger;
  private readonly string _natsUrl;
  private readonly string _rethinkHost;
  private readonly int _rethinkPort;
  private readonly string _rethinkDb;
  private readonly string _rethinkUser;
  private readonly string _rethinkPassword;
  private readonly RethinkDB _r = RethinkDB.R;
  private readonly SemaphoreSlim _eventLock = new(1, 1);

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
    subscription.MessageHandler += async (_, args) =>
    {
      var payload = Encoding.UTF8.GetString(args.Message.Data ?? []);
      await HandleEventAsync(connection, payload, stoppingToken);
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
    await EnsureTableAsync(connection, tables, ProjectThreadTable);
    await EnsureTableAsync(connection, tables, ThreadIssueCardTable);
    await EnsureTableAsync(connection, tables, RootThreadTable);
    await EnsureTableAsync(connection, tables, PhysicalThreadTable);
    await EnsureTableAsync(connection, tables, HandoffSummaryTable);
    await EnsureTableAsync(connection, tables, LogicalThreadTimelineTable);
    await EnsureTableAsync(connection, tables, LogicalThreadIssueBoardTable);
    await EnsureTableAsync(connection, tables, TodoChatTable);
    await EnsureTableAsync(connection, tables, TodoMessageTable);
    await EnsureTableAsync(connection, tables, EventTable);
  }

  private async Task HandleEventAsync(RethinkConnection connection, string payload, CancellationToken stoppingToken)
  {
    await _eventLock.WaitAsync(stoppingToken);
    try
    {
      var @event = JObject.Parse(payload);
      await PersistEventAsync(connection, @event);
      await UpsertBridgeNodeAsync(connection, @event);
      await UpsertProjectsAsync(connection, @event);
      await UpsertUserStateAsync(connection, @event);
      await UpsertProjectThreadsAsync(connection, @event);
      await UpsertIssueCardsAsync(connection, @event);
      await UpsertRootThreadsAsync(connection, @event);
      await UpsertPhysicalThreadsAsync(connection, @event);
      await UpsertHandoffSummariesAsync(connection, @event);
      await UpsertLogicalThreadTimelineAsync(connection, @event);
      await UpsertLogicalThreadIssueBoardAsync(connection, @event);
      await UpsertTodoChatsAsync(connection, @event);
      await UpsertTodoMessagesAsync(connection, @event);
    }
    catch (Exception exception) when (!stoppingToken.IsCancellationRequested)
    {
      _logger.LogError(exception, "Projection worker failed to persist event payload");
    }
    finally
    {
      _eventLock.Release();
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

    if ((string?)@event["type"] == "bridge.projectThreads.updated")
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
    var hostName = @event.Value<string>("host_name") ?? @event["payload"]?["host_name"]?.Value<string>();
    var existing = await _r.Db(_rethinkDb)
      .Table(BridgeNodeTable)
      .Get(bridgeId)
      .RunResultAsync<JObject?>(connection) ?? new JObject
      {
        ["id"] = bridgeId,
        ["bridge_id"] = bridgeId,
        ["login_id"] = loginId,
        ["user_id"] = loginId,
        ["host_name"] = hostName,
        ["device_name"] = @event.Value<string>("device_name") ?? bridgeId,
        ["status"] = "unknown",
        ["created_at"] = timestamp
      };

    existing["login_id"] = loginId;
    existing["user_id"] = loginId;
    existing["host_name"] = hostName ?? existing.Value<string>("host_name");
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
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var bridgeId = @event.Value<string>("bridge_id") ?? "unknown-bridge";
    var timestamp = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");
    var projectIds = new HashSet<string>(
      (projects ?? []).OfType<JObject>()
        .Select(token => token.Value<string>("id"))
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Cast<string>(),
      StringComparer.Ordinal);

    await DeleteMissingProjectsAsync(connection, loginId, bridgeId, projectIds);

    if (projects is null || projects.Count == 0)
    {
      return;
    }

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

  private async Task UpsertProjectThreadsAsync(RethinkConnection connection, JObject @event)
  {
    var thread = @event["payload"]?["thread"] as JObject;
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var eventType = @event.Value<string>("type");
    var projectedAt = @event.Value<string>("timestamp");
    var projectId = @event["payload"]?["project_id"]?.Value<string>();

    if (thread?["id"] is not null)
    {
      thread["login_id"] = loginId;
      thread["user_id"] = loginId;
      thread["bridge_id"] = bridgeId;
      thread["last_event_type"] = eventType;
      thread["projected_at"] = projectedAt;
      await UpsertThreadDocumentAsync(connection, ProjectThreadTable, thread, projectedAt);
      await UpsertThreadDocumentAsync(connection, ThreadTable, new JObject(thread), projectedAt);
    }

    if (eventType != "bridge.projectThreads.updated")
    {
      return;
    }

    var scope = @event["payload"]?["scope"]?.Value<string>() ?? "project";
    var threads = @event["payload"]?["threads"] as JArray;
    var threadIds = new HashSet<string>(
      (threads ?? []).OfType<JObject>()
        .Select(item => item.Value<string>("id"))
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Cast<string>(),
      StringComparer.Ordinal);

    await DeleteMissingThreadsAsync(connection, ProjectThreadTable, loginId, bridgeId, scope == "all" ? null : projectId, threadIds);
    await DeleteMissingThreadsAsync(connection, ThreadTable, loginId, bridgeId, scope == "all" ? null : projectId, threadIds);

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
      await UpsertThreadDocumentAsync(connection, ProjectThreadTable, item, projectedAt);
      await UpsertThreadDocumentAsync(connection, ThreadTable, new JObject(item), projectedAt);
    }
  }

  private async Task UpsertRootThreadsAsync(RethinkConnection connection, JObject @event)
  {
    var eventType = @event.Value<string>("type");
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var projectedAt = @event.Value<string>("timestamp");

    if (eventType is "rootThread.deleted" or "thread.deleted")
    {
      var rootThreadId = @event["payload"]?["root_thread_id"]?.Value<string>() ?? @event["payload"]?["thread_id"]?.Value<string>();

      if (!string.IsNullOrWhiteSpace(rootThreadId))
      {
        await DeleteRootThreadArtifactsAsync(connection, rootThreadId);
      }

      return;
    }

    if (
      eventType == "thread.created" ||
      eventType == "thread.updated" ||
      eventType == "rootThread.created" ||
      eventType == "rootThread.updated" ||
      eventType == "physicalThread.bound")
    {
      var thread = @event["payload"]?["thread"] as JObject;

      if (thread is null || thread["id"] is null)
      {
        return;
      }

      if (thread.Value<string>("deleted_at") is not null)
      {
        await DeleteRootThreadArtifactsAsync(connection, thread.Value<string>("id") ?? string.Empty);
        return;
      }

      thread["login_id"] = loginId;
      thread["user_id"] = loginId;
      thread["bridge_id"] = bridgeId;
      thread["last_event_type"] = eventType;
      thread["projected_at"] = projectedAt;
      await UpsertThreadDocumentAsync(connection, RootThreadTable, thread, projectedAt);
      return;
    }

    if (eventType != "bridge.projectThreads.updated")
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
      await UpsertThreadDocumentAsync(connection, RootThreadTable, item, projectedAt);
    }
  }

  private async Task DeleteRootThreadArtifactsAsync(RethinkConnection connection, string rootThreadId)
  {
    var tables = new[]
    {
      RootThreadTable,
      PhysicalThreadTable,
      HandoffSummaryTable,
      LogicalThreadTimelineTable,
      LogicalThreadIssueBoardTable,
      ThreadIssueCardTable,
      ProjectThreadTable,
      ThreadTable
    };

    foreach (var tableName in tables)
    {
      var rows = await ReadTableRowsAsync(connection, tableName);

      foreach (var row in rows)
      {
        var rowId = row.Value<string>("id");
        var rowRootThreadId = row.Value<string>("root_thread_id") ?? row.Value<string>("thread_id") ?? row.Value<string>("id");

        if (string.IsNullOrWhiteSpace(rowId) || !string.Equals(rowRootThreadId, rootThreadId, StringComparison.Ordinal))
        {
          continue;
        }

        await _r.Db(_rethinkDb).Table(tableName).Get(rowId).Delete().RunResultAsync<object>(connection);
      }
    }
  }

  private async Task UpsertPhysicalThreadsAsync(RethinkConnection connection, JObject @event)
  {
    var eventType = @event.Value<string>("type");

    if (eventType is not ("physicalThread.created" or "physicalThread.closed" or "physicalThread.bound" or "physicalThread.updated"))
    {
      return;
    }

    var physicalThread = @event["payload"]?["physical_thread"] as JObject;

    if (physicalThread is null || physicalThread["id"] is null)
    {
      return;
    }

    physicalThread["login_id"] = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    physicalThread["user_id"] = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    physicalThread["bridge_id"] = @event.Value<string>("bridge_id");
    physicalThread["last_event_type"] = eventType;
    physicalThread["projected_at"] = @event.Value<string>("timestamp");
    if (physicalThread.Value<string>("deleted_at") is not null)
    {
      return;
    }

    if (eventType == "physicalThread.updated" && physicalThread.Value<string>("closed_at") is not null)
    {
      return;
    }

    await UpsertThreadDocumentAsync(connection, PhysicalThreadTable, physicalThread, physicalThread.Value<string>("projected_at"));
  }

  private async Task UpsertHandoffSummariesAsync(RethinkConnection connection, JObject @event)
  {
    if ((string?)@event["type"] != "handoffSummary.created")
    {
      return;
    }

    var summary = @event["payload"]?["summary"] as JObject;

    if (summary is null || summary["id"] is null)
    {
      return;
    }

    summary["login_id"] = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    summary["user_id"] = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    summary["bridge_id"] = @event.Value<string>("bridge_id");
    summary["last_event_type"] = @event.Value<string>("type");
    summary["projected_at"] = @event.Value<string>("timestamp");
    await UpsertThreadDocumentAsync(connection, HandoffSummaryTable, summary, summary.Value<string>("projected_at"));
  }

  private async Task UpsertLogicalThreadTimelineAsync(RethinkConnection connection, JObject @event)
  {
    if ((string?)@event["type"] != "logicalThread.timeline.updated")
    {
      return;
    }

    var rootThreadId = @event["payload"]?["root_thread_id"]?.Value<string>();
    var entries = @event["payload"]?["entries"] as JArray;
    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var projectedAt = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");

    if (string.IsNullOrWhiteSpace(rootThreadId))
    {
      return;
    }

    var existingRows = await ReadTableRowsAsync(connection, LogicalThreadTimelineTable);

    foreach (var row in existingRows.Where(row =>
               string.Equals(row.Value<string>("root_thread_id"), rootThreadId, StringComparison.Ordinal)))
    {
      var rowId = row.Value<string>("id");

      if (!string.IsNullOrWhiteSpace(rowId))
      {
        await _r.Db(_rethinkDb).Table(LogicalThreadTimelineTable).Get(rowId).Delete().RunResultAsync<object>(connection);
      }
    }

    if (entries is null)
    {
      return;
    }

    var index = 0;
    foreach (var entry in entries.OfType<JObject>())
    {
      entry["id"] = $"{rootThreadId}:{index++:D6}:{entry.Value<string>("id") ?? Guid.NewGuid().ToString("N")}";
      entry["root_thread_id"] = rootThreadId;
      entry["login_id"] = loginId;
      entry["user_id"] = loginId;
      entry["bridge_id"] = bridgeId;
      entry["last_event_type"] = @event.Value<string>("type");
      entry["projected_at"] = projectedAt;
      await _r.Db(_rethinkDb)
        .Table(LogicalThreadTimelineTable)
        .Insert(entry)
        .OptArg("conflict", "replace")
        .RunResultAsync<object>(connection);
    }
  }

  private async Task UpsertLogicalThreadIssueBoardAsync(RethinkConnection connection, JObject @event)
  {
    if ((string?)@event["type"] != "bridge.threadIssues.updated")
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var rootThreadId = @event["payload"]?["thread_id"]?.Value<string>();
    var issues = @event["payload"]?["issues"] as JArray;
    var projectedAt = @event.Value<string>("timestamp");

    if (string.IsNullOrWhiteSpace(rootThreadId))
    {
      return;
    }

    var existingIssues = await ReadTableRowsAsync(connection, LogicalThreadIssueBoardTable);

    foreach (var issue in existingIssues.Where(issue =>
               string.Equals(issue.Value<string>("root_thread_id"), rootThreadId, StringComparison.Ordinal)))
    {
      var issueId = issue.Value<string>("id");

      if (!string.IsNullOrWhiteSpace(issueId))
      {
        await _r.Db(_rethinkDb).Table(LogicalThreadIssueBoardTable).Get(issueId).Delete().RunResultAsync<object>(connection);
      }
    }

    if (issues is null)
    {
      return;
    }

    foreach (var item in issues.OfType<JObject>())
    {
      var issueId = item.Value<string>("id");

      if (string.IsNullOrWhiteSpace(issueId))
      {
        continue;
      }

      item["root_thread_id"] = item.Value<string>("root_thread_id") ?? rootThreadId;
      item["thread_id"] = item.Value<string>("thread_id") ?? rootThreadId;
      item["login_id"] = loginId;
      item["user_id"] = loginId;
      item["bridge_id"] = bridgeId;
      item["last_event_type"] = @event.Value<string>("type");
      item["projected_at"] = projectedAt;
      await _r.Db(_rethinkDb)
        .Table(LogicalThreadIssueBoardTable)
        .Insert(item)
        .OptArg("conflict", "replace")
        .RunResultAsync<object>(connection);
    }
  }

  private async Task UpsertTodoChatsAsync(RethinkConnection connection, JObject @event)
  {
    var type = (string?)@event["type"];

    if (type != "todo.chat.created" &&
        type != "todo.chat.updated" &&
        type != "todo.chat.deleted" &&
        type != "bridge.todoChats.updated")
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var bridgeId = @event.Value<string>("bridge_id") ?? "unknown-bridge";
    var projectedAt = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");

    if (type == "todo.chat.deleted")
    {
      var chatId = @event["payload"]?["todo_chat_id"]?.Value<string>() ??
                   @event["payload"]?["chat_id"]?.Value<string>();

      if (string.IsNullOrWhiteSpace(chatId))
      {
        return;
      }

      await _r.Db(_rethinkDb)
        .Table(TodoChatTable)
        .Get(chatId)
        .Update(new
        {
          deleted_at = projectedAt,
          updated_at = projectedAt,
          last_event_type = type,
          projected_at = projectedAt
        })
        .RunResultAsync<object>(connection);

      return;
    }

    if (type == "bridge.todoChats.updated")
    {
      var chats = @event["payload"]?["chats"] as JArray;

      if (chats is null)
      {
        return;
      }

      foreach (var chat in chats.OfType<JObject>())
      {
        await UpsertTodoChatDocumentAsync(connection, chat, loginId, bridgeId, type, projectedAt);
      }

      return;
    }

    var singleChat = @event["payload"]?["chat"] as JObject;

    if (singleChat is null)
    {
      return;
    }

    await UpsertTodoChatDocumentAsync(connection, singleChat, loginId, bridgeId, type, projectedAt);
  }

  private async Task UpsertTodoMessagesAsync(RethinkConnection connection, JObject @event)
  {
    var type = (string?)@event["type"];

    if (type != "todo.message.created" &&
        type != "todo.message.updated" &&
        type != "todo.message.deleted" &&
        type != "todo.message.transferred")
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id") ?? "unknown-user";
    var bridgeId = @event.Value<string>("bridge_id") ?? "unknown-bridge";
    var projectedAt = @event.Value<string>("timestamp") ?? DateTimeOffset.UtcNow.ToString("O");

    if (type == "todo.message.deleted")
    {
      var messageId = @event["payload"]?["todo_message_id"]?.Value<string>() ??
                      @event["payload"]?["message_id"]?.Value<string>();

      if (string.IsNullOrWhiteSpace(messageId))
      {
        return;
      }

      await _r.Db(_rethinkDb)
        .Table(TodoMessageTable)
        .Get(messageId)
        .Update(new
        {
          status = "deleted",
          deleted_at = projectedAt,
          updated_at = projectedAt,
          last_event_type = type,
          projected_at = projectedAt
        })
        .RunResultAsync<object>(connection);

      return;
    }

    var message = @event["payload"]?["message"] as JObject;

    if (message is null)
    {
      return;
    }

    var normalized = NormalizeTodoMessageDocument(message, loginId, bridgeId, type, projectedAt);

    if (normalized is null)
    {
      return;
    }

    await _r.Db(_rethinkDb)
      .Table(TodoMessageTable)
      .Insert(normalized)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private async Task UpsertTodoChatDocumentAsync(
    RethinkConnection connection,
    JObject chat,
    string loginId,
    string bridgeId,
    string eventType,
    string projectedAt)
  {
    var normalized = NormalizeTodoChatDocument(chat, loginId, bridgeId, eventType, projectedAt);

    if (normalized is null)
    {
      return;
    }

    await _r.Db(_rethinkDb)
      .Table(TodoChatTable)
      .Insert(normalized)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private static JObject? NormalizeTodoChatDocument(
    JObject chat,
    string loginId,
    string bridgeId,
    string eventType,
    string projectedAt)
  {
    var normalized = (JObject)chat.DeepClone();
    var chatId = normalized.Value<string>("id");

    if (string.IsNullOrWhiteSpace(chatId))
    {
      return null;
    }

    normalized["id"] = chatId;
    var owner = normalized.Value<string>("login_id") ?? loginId;
    normalized["login_id"] = owner;
    normalized["user_id"] = owner;
    normalized["bridge_id"] = normalized.Value<string>("bridge_id") ?? bridgeId;
    normalized["created_at"] = normalized.Value<string>("created_at") ?? projectedAt;
    normalized["updated_at"] = normalized.Value<string>("updated_at") ?? projectedAt;
    normalized["last_event_type"] = eventType;
    normalized["projected_at"] = projectedAt;
    return normalized;
  }

  private static JObject? NormalizeTodoMessageDocument(
    JObject message,
    string loginId,
    string bridgeId,
    string eventType,
    string projectedAt)
  {
    var normalized = (JObject)message.DeepClone();
    var messageId = normalized.Value<string>("id");
    var chatId = normalized.Value<string>("todo_chat_id") ?? normalized.Value<string>("todoChatId");

    if (string.IsNullOrWhiteSpace(messageId) || string.IsNullOrWhiteSpace(chatId))
    {
      return null;
    }

    normalized["id"] = messageId;
    normalized["todo_chat_id"] = chatId;
    var owner = normalized.Value<string>("login_id") ?? loginId;
    normalized["login_id"] = owner;
    normalized["user_id"] = owner;
    normalized["bridge_id"] = normalized.Value<string>("bridge_id") ?? bridgeId;
    normalized["created_at"] = normalized.Value<string>("created_at") ?? projectedAt;
    normalized["updated_at"] = normalized.Value<string>("updated_at") ?? projectedAt;
    normalized["last_event_type"] = eventType;
    normalized["projected_at"] = projectedAt;
    return normalized;
  }

  private async Task UpsertIssueCardsAsync(RethinkConnection connection, JObject @event)
  {
    if ((string?)@event["type"] != "bridge.threadIssues.updated")
    {
      return;
    }

    var loginId = @event.Value<string>("login_id") ?? @event.Value<string>("user_id");
    var bridgeId = @event.Value<string>("bridge_id");
    var projectedAt = @event.Value<string>("timestamp");
    var threadId = @event["payload"]?["thread_id"]?.Value<string>();
    var issues = @event["payload"]?["issues"] as JArray;
    var issueIds = new HashSet<string>(
      (issues ?? []).OfType<JObject>()
        .Select(item => item.Value<string>("id"))
        .Where(value => !string.IsNullOrWhiteSpace(value))
        .Cast<string>(),
      StringComparer.Ordinal);

    await DeleteMissingIssueCardsAsync(connection, loginId, bridgeId, threadId, issueIds);

    if (issues is null)
    {
      return;
    }

    foreach (var item in issues.OfType<JObject>())
    {
      var issueId = item.Value<string>("id");

      if (string.IsNullOrWhiteSpace(issueId))
      {
        continue;
      }

      item["login_id"] = loginId;
      item["user_id"] = loginId;
      item["bridge_id"] = bridgeId;
      item["thread_id"] = item.Value<string>("thread_id") ?? threadId;
      item["last_event_type"] = @event.Value<string>("type");
      item["projected_at"] = projectedAt;

      var existing = await _r.Db(_rethinkDb)
        .Table(ThreadIssueCardTable)
        .Get(issueId)
        .RunResultAsync<JObject?>(connection);

      if (!ShouldReplaceProjection(existing, projectedAt))
      {
        continue;
      }

      PreserveTerminalStatus(existing, item);

      await _r.Db(_rethinkDb)
        .Table(ThreadIssueCardTable)
        .Insert(item)
        .OptArg("conflict", "replace")
        .RunResultAsync<object>(connection);
    }
  }

  private async Task UpsertThreadDocumentAsync(RethinkConnection connection, string tableName, JObject thread, string? projectedAt)
  {
    var threadId = thread.Value<string>("id");

    if (string.IsNullOrWhiteSpace(threadId))
    {
      return;
    }

    var existing = await _r.Db(_rethinkDb)
      .Table(tableName)
      .Get(threadId)
      .RunResultAsync<JObject?>(connection);

    if (!ShouldReplaceProjection(existing, projectedAt))
    {
      return;
    }

    PreserveTerminalStatus(existing, thread);

    await _r.Db(_rethinkDb)
      .Table(tableName)
      .Insert(thread)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  private static bool ShouldReplaceProjection(JObject? existing, string? incomingProjectedAt)
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

  private async Task DeleteMissingProjectsAsync(
    RethinkConnection connection,
    string loginId,
    string bridgeId,
    HashSet<string> activeProjectIds)
  {
    var existingProjects = await ReadTableRowsAsync(connection, ProjectTable);

    foreach (var project in existingProjects)
    {
      var projectId = project.Value<string>("id");

      if (string.IsNullOrWhiteSpace(projectId))
      {
        continue;
      }

      if (
        string.Equals(project.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
        string.Equals(project.Value<string>("owner_login_id") ?? project.Value<string>("owner_user_id"), loginId, StringComparison.Ordinal) &&
        !activeProjectIds.Contains(projectId))
      {
        await _r.Db(_rethinkDb).Table(ProjectTable).Get(projectId).Delete().RunResultAsync<object>(connection);
      }
    }

    var memberships = await ReadTableRowsAsync(connection, ProjectMemberTable);

    foreach (var membership in memberships)
    {
      var membershipId = membership.Value<string>("id");
      var projectId = membership.Value<string>("project_id");

      if (string.IsNullOrWhiteSpace(membershipId) || string.IsNullOrWhiteSpace(projectId))
      {
        continue;
      }

      if (
        string.Equals(membership.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
        string.Equals(membership.Value<string>("login_id") ?? membership.Value<string>("user_id"), loginId, StringComparison.Ordinal) &&
        !activeProjectIds.Contains(projectId))
      {
        await _r.Db(_rethinkDb).Table(ProjectMemberTable).Get(membershipId).Delete().RunResultAsync<object>(connection);
      }
    }
  }

  private async Task DeleteMissingThreadsAsync(
    RethinkConnection connection,
    string tableName,
    string? loginId,
    string? bridgeId,
    string? projectId,
    HashSet<string> activeThreadIds)
  {
    if (string.IsNullOrWhiteSpace(loginId) || string.IsNullOrWhiteSpace(bridgeId))
    {
      return;
    }

    var existingThreads = await ReadTableRowsAsync(connection, tableName);

    foreach (var thread in existingThreads)
    {
      var threadId = thread.Value<string>("id");

      if (string.IsNullOrWhiteSpace(threadId))
      {
        continue;
      }

      if (
        string.Equals(thread.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
        string.Equals(thread.Value<string>("login_id") ?? thread.Value<string>("user_id"), loginId, StringComparison.Ordinal) &&
        (string.IsNullOrWhiteSpace(projectId) || string.Equals(thread.Value<string>("project_id"), projectId, StringComparison.Ordinal)) &&
        !activeThreadIds.Contains(threadId))
      {
        await _r.Db(_rethinkDb).Table(tableName).Get(threadId).Delete().RunResultAsync<object>(connection);
      }
    }
  }

  private async Task DeleteMissingIssueCardsAsync(
    RethinkConnection connection,
    string? loginId,
    string? bridgeId,
    string? threadId,
    HashSet<string> activeIssueIds)
  {
    if (string.IsNullOrWhiteSpace(loginId) || string.IsNullOrWhiteSpace(bridgeId) || string.IsNullOrWhiteSpace(threadId))
    {
      return;
    }

    var existingIssues = await ReadTableRowsAsync(connection, ThreadIssueCardTable);

    foreach (var issue in existingIssues)
    {
      var issueId = issue.Value<string>("id");

      if (string.IsNullOrWhiteSpace(issueId))
      {
        continue;
      }

      if (
        string.Equals(issue.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
        string.Equals(issue.Value<string>("login_id") ?? issue.Value<string>("user_id"), loginId, StringComparison.Ordinal) &&
        string.Equals(issue.Value<string>("thread_id"), threadId, StringComparison.Ordinal) &&
        !activeIssueIds.Contains(issueId))
      {
        await _r.Db(_rethinkDb).Table(ThreadIssueCardTable).Get(issueId).Delete().RunResultAsync<object>(connection);
      }
    }
  }

  private async Task<List<JObject>> ReadTableRowsAsync(RethinkConnection connection, string tableName)
  {
    using var cursor = await _r.Db(_rethinkDb).Table(tableName).RunCursorAsync<JObject>(connection, CancellationToken.None);
    var rows = new List<JObject>();

    while (await cursor.MoveNextAsync(CancellationToken.None))
    {
      if (cursor.Current is null)
      {
        continue;
      }

      rows.Add(cursor.Current);
    }

    return rows;
  }
}
