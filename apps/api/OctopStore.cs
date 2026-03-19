using Newtonsoft.Json.Linq;
using RethinkDb.Driver;
using RethinkConnection = RethinkDb.Driver.Net.Connection;

namespace OctOP.Gateway;

public sealed class OctopStore : IAsyncDisposable
{
  private const string UserTable = "users";
  private const string BridgeNodeTable = "bridge_nodes";
  private const string ProjectTable = "projects";
  private const string ProjectMemberTable = "project_members";
  private const string ThreadTable = "thread_projection";
  private const string ProjectThreadTable = "project_threads";
  private const string ThreadIssueCardTable = "thread_issue_cards";
  private const string RootThreadTable = "root_threads";
  private const string PhysicalThreadTable = "physical_threads";
  private const string HandoffSummaryTable = "handoff_summaries";
  private const string LogicalThreadTimelineTable = "logical_thread_timeline";
  private const string LogicalThreadIssueBoardTable = "logical_thread_issue_board";
  private const string DashboardArchiveTable = "dashboard_archives";
  private const string TodoChatTable = "todo_chats";
  private const string TodoMessageTable = "todo_messages";
  private const string PushSubscriptionTable = "push_subscriptions";
  private const string PushNotificationReceiptTable = "push_notification_receipts";

  private readonly string _host;
  private readonly int _port;
  private readonly string _db;
  private readonly string _user;
  private readonly string _password;
  private readonly RethinkDB _r = RethinkDB.R;
  private readonly SemaphoreSlim _storageLock = new(1, 1);
  private RethinkConnection? _connection;
  private bool _storageEnsured;

  public OctopStore()
  {
    _host = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_HOST") ?? "rethinkdb.ilycode.app";
    _port = int.TryParse(Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_PORT"), out var port)
      ? port
      : 28015;
    _db = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_DB") ?? "OctOP";
    _user = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_USER") ?? string.Empty;
    _password = Environment.GetEnvironmentVariable("OCTOP_RETHINKDB_PASSWORD") ?? string.Empty;
  }

  public async Task EnsureStorageAsync()
  {
    if (_storageEnsured)
    {
      return;
    }

    await _storageLock.WaitAsync();
    try
    {
      if (_storageEnsured)
      {
        return;
      }

      using var connection = await _r.Connection()
        .Hostname(_host)
        .Port(_port)
        .User(_user, _password)
        .ConnectAsync();

      var databases = await _r.DbList().RunResultAsync<List<string>>(connection);

      if (!databases.Contains(_db))
      {
        await _r.DbCreate(_db).RunResultAsync<object>(connection);
      }

      var tables = await _r.Db(_db).TableList().RunResultAsync<List<string>>(connection);
      await EnsureTableAsync(connection, tables, UserTable);
      await EnsureTableAsync(connection, tables, BridgeNodeTable);
      await EnsureTableAsync(connection, tables, ProjectTable);
      await EnsureTableAsync(connection, tables, ProjectMemberTable);
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
      await EnsureTableAsync(connection, tables, DashboardArchiveTable);
      await EnsureTableAsync(connection, tables, PushSubscriptionTable);
      await EnsureTableAsync(connection, tables, PushNotificationReceiptTable);
      _storageEnsured = true;
    }
    finally
    {
      _storageLock.Release();
    }
  }

  public async Task UpsertUserAsync(JObject user)
  {
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(UserTable)
      .Insert(user)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async Task<JArray> ListBridgesForUserAsync(string userId)
  {
    var connection = await GetConnectionAsync();
    var bridges = await ReadTableRowsAsync(connection, BridgeNodeTable);

    return new JArray(
      bridges
        .Where(bridge => string.Equals(
          bridge.Value<string>("login_id") ?? bridge.Value<string>("user_id"),
          userId,
          StringComparison.Ordinal))
        .OrderByDescending(bridge => DateTimeOffset.TryParse(bridge.Value<string>("last_seen_at"), out var seenAt) ? seenAt : DateTimeOffset.MinValue)
    );
  }

  public async Task<JArray> ListProjectsForUserAsync(string userId, string bridgeId)
  {
    var connection = await GetConnectionAsync();
    var memberships = await ReadTableRowsAsync(connection, ProjectMemberTable);
    var projectIds = memberships
      .Where(item =>
        string.Equals(item.Value<string>("login_id") ?? item.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
        string.Equals(item.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal))
      .Select(item => item.Value<string>("project_id"))
      .Where(value => !string.IsNullOrWhiteSpace(value))
      .Cast<string>()
      .ToHashSet(StringComparer.Ordinal);

    if (projectIds.Count == 0)
    {
      return [];
    }

    var projects = await ReadTableRowsAsync(connection, ProjectTable);

    return new JArray(
      projects
        .Where(project =>
          string.Equals(project.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
          projectIds.Contains(project.Value<string>("id") ?? string.Empty))
        .OrderBy(project => project.Value<string>("name"))
    );
  }

  public async Task<JArray> ListThreadsAsync(string userId, string bridgeId, string? projectId)
  {
    var connection = await GetConnectionAsync();
    var threads = await ReadTableRowsAsync(connection, ThreadTable);

    return new JArray(
      threads
        .Where(thread =>
          string.Equals(thread.Value<string>("login_id") ?? thread.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
          string.Equals(thread.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal))
        .Where(thread => string.IsNullOrWhiteSpace(projectId) || string.Equals(thread.Value<string>("project_id"), projectId, StringComparison.Ordinal))
        .OrderByDescending(thread => DateTimeOffset.TryParse(thread.Value<string>("updated_at"), out var updatedAt) ? updatedAt : DateTimeOffset.MinValue)
    );
  }

  public async Task<JArray> ListLogicalThreadIssueBoardAsync(string userId, string bridgeId, string rootThreadId)
  {
    if (string.IsNullOrWhiteSpace(rootThreadId))
    {
      return [];
    }

    var connection = await GetConnectionAsync();
    var issues = await ReadTableRowsAsync(connection, LogicalThreadIssueBoardTable);

    return new JArray(
      issues
        .Where(issue =>
          string.Equals(issue.Value<string>("login_id") ?? issue.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
          string.Equals(issue.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
          string.Equals(issue.Value<string>("root_thread_id"), rootThreadId, StringComparison.Ordinal) &&
          string.IsNullOrWhiteSpace(issue.Value<string>("deleted_at")))
        .OrderByDescending(issue => DateTimeOffset.TryParse(issue.Value<string>("updated_at"), out var updatedAt) ? updatedAt : DateTimeOffset.MinValue)
    );
  }

  public async Task<JArray> ListLogicalThreadTimelineAsync(string userId, string bridgeId, string rootThreadId)
  {
    if (string.IsNullOrWhiteSpace(rootThreadId))
    {
      return [];
    }

    var connection = await GetConnectionAsync();
    var entries = await ReadTableRowsAsync(connection, LogicalThreadTimelineTable);

    return new JArray(
      entries
        .Where(entry =>
          string.Equals(entry.Value<string>("login_id") ?? entry.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
          string.Equals(entry.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
          string.Equals(entry.Value<string>("root_thread_id"), rootThreadId, StringComparison.Ordinal) &&
          string.IsNullOrWhiteSpace(entry.Value<string>("deleted_at")))
        .OrderBy(entry => DateTimeOffset.TryParse(entry.Value<string>("timestamp"), out var timestamp) ? timestamp : DateTimeOffset.MinValue)
    );
  }

  public async Task<bool> UserOwnsBridgeAsync(string userId, string bridgeId)
  {
    var bridges = await ListBridgesForUserAsync(userId);
    return bridges.OfType<JObject>().Any(bridge => string.Equals(bridge.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal));
  }

  public async Task EnsureProjectMembershipAsync(string userId, string bridgeId, string projectId)
  {
    var connection = await GetConnectionAsync();
    var membership = new JObject
    {
      ["id"] = $"{userId}:{projectId}",
      ["login_id"] = userId,
      ["user_id"] = userId,
      ["project_id"] = projectId,
      ["bridge_id"] = bridgeId,
      ["role"] = "owner",
      ["updated_at"] = DateTimeOffset.UtcNow.ToString("O")
    };

    await _r.Db(_db)
      .Table(ProjectMemberTable)
      .Insert(membership)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async Task<JObject> GetDashboardArchivesAsync(string userId)
  {
    var connection = await GetConnectionAsync();
    var document = await _r.Db(_db)
      .Table(DashboardArchiveTable)
      .Get(userId)
      .RunResultAsync<JObject?>(connection);

    return document?["archives"] as JObject ?? new JObject();
  }

  public async Task UpsertDashboardArchivesAsync(string userId, JObject archives)
  {
    var connection = await GetConnectionAsync();
    var document = new JObject
    {
      ["id"] = userId,
      ["login_id"] = userId,
      ["user_id"] = userId,
      ["archives"] = archives,
      ["updated_at"] = DateTimeOffset.UtcNow.ToString("O")
    };

    await _r.Db(_db)
      .Table(DashboardArchiveTable)
      .Insert(document)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async Task DeleteBridgeForUserAsync(string userId, string bridgeId)
  {
    var connection = await GetConnectionAsync();
    var bridge = await _r.Db(_db)
      .Table(BridgeNodeTable)
      .Get(bridgeId)
      .RunResultAsync<JObject?>(connection);

    if (
      bridge is null ||
      !string.Equals(
        bridge.Value<string>("login_id") ?? bridge.Value<string>("user_id"),
        userId,
        StringComparison.Ordinal))
    {
      return;
    }

    foreach (var tableName in new[]
    {
      ProjectMemberTable,
      ProjectTable,
      ThreadTable,
      ProjectThreadTable,
      ThreadIssueCardTable,
      RootThreadTable,
      PhysicalThreadTable,
      HandoffSummaryTable,
      LogicalThreadTimelineTable,
      LogicalThreadIssueBoardTable,
      TodoChatTable,
      TodoMessageTable,
      PushSubscriptionTable,
      PushNotificationReceiptTable
    })
    {
      await DeleteRowsByBridgeIdAsync(connection, tableName, bridgeId);
    }

    await _r.Db(_db)
      .Table(BridgeNodeTable)
      .Get(bridgeId)
      .Delete()
      .RunResultAsync<object>(connection);

    await RemoveBridgeArchiveStateAsync(userId, bridgeId);
  }

  public async Task RemoveBridgeArchiveStateAsync(string userId, string bridgeId)
  {
    var connection = await GetConnectionAsync();
    var document = await _r.Db(_db)
      .Table(DashboardArchiveTable)
      .Get(userId)
      .RunResultAsync<JObject?>(connection);

    if (document?["archives"] is not JObject archives)
    {
      return;
    }

    if (!archives.Remove(bridgeId))
    {
      return;
    }

    document["archives"] = archives;
    document["updated_at"] = DateTimeOffset.UtcNow.ToString("O");

    await _r.Db(_db)
      .Table(DashboardArchiveTable)
      .Insert(document)
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async ValueTask DisposeAsync()
  {
    if (_connection is not null)
    {
      _connection.Close(false);
      _connection.Dispose();
    }
  }

  private async Task<RethinkConnection> GetConnectionAsync()
  {
    await EnsureStorageAsync();

    if (_connection is not null)
    {
      return _connection;
    }

    _connection = await _r.Connection()
      .Hostname(_host)
      .Port(_port)
      .Db(_db)
      .User(_user, _password)
      .ConnectAsync();

    return _connection;
  }

  private async Task EnsureTableAsync(RethinkConnection connection, IReadOnlyCollection<string> tables, string tableName)
  {
    if (!tables.Contains(tableName))
    {
      await _r.Db(_db).TableCreate(tableName).RunResultAsync<object>(connection);
    }
  }

  private async Task<List<JObject>> ReadTableRowsAsync(RethinkConnection connection, string tableName)
  {
    using var cursor = await _r.Db(_db).Table(tableName).RunCursorAsync<JObject>(connection, CancellationToken.None);
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

  private async Task DeleteRowsByBridgeIdAsync(RethinkConnection connection, string tableName, string bridgeId)
  {
    await _r.Db(_db)
      .Table(tableName)
      .Filter(new JObject
      {
        ["bridge_id"] = bridgeId
      })
      .Delete()
      .RunResultAsync<object>(connection);
  }

  public async Task<IReadOnlyList<PushSubscriptionEntity>> ListPushSubscriptionsAsync(
    string userId,
    string bridgeId,
    string? appId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    using var cursor = await _r.Db(_db)
      .Table(PushSubscriptionTable)
      .RunCursorAsync<PushSubscriptionEntity>(connection, cancellationToken);
    var rows = new List<PushSubscriptionEntity>();

    while (await cursor.MoveNextAsync(cancellationToken))
    {
      var row = cursor.Current;

      if (
        row is null ||
        !row.IsActive ||
        !string.Equals(row.LoginId ?? row.UserId, userId, StringComparison.Ordinal) ||
        !string.Equals(row.BridgeId, bridgeId, StringComparison.Ordinal) ||
        (!string.IsNullOrWhiteSpace(appId) && !string.Equals(row.AppId, appId, StringComparison.Ordinal)))
      {
        continue;
      }

      rows.Add(row);
    }

    return rows;
  }

  public async Task<PushSubscriptionEntity?> GetPushSubscriptionAsync(string subscriptionId, CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    return await _r.Db(_db)
      .Table(PushSubscriptionTable)
      .Get(subscriptionId)
      .RunResultAsync<PushSubscriptionEntity?>(connection);
  }

  public async Task UpsertPushSubscriptionAsync(PushSubscriptionEntity subscription, CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(PushSubscriptionTable)
      .Insert(JObject.FromObject(subscription))
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async Task DeletePushSubscriptionAsync(string subscriptionId, CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(PushSubscriptionTable)
      .Get(subscriptionId)
      .Delete()
      .RunResultAsync<object>(connection);
  }

  public async Task DeletePushSubscriptionsByEndpointAsync(string endpoint, CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(PushSubscriptionTable)
      .Filter(new JObject
      {
        ["endpoint"] = endpoint
      })
      .Delete()
      .RunResultAsync<object>(connection);
  }

  public async Task<PushNotificationReceiptEntity?> GetPushNotificationReceiptAsync(
    string receiptId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    return await _r.Db(_db)
      .Table(PushNotificationReceiptTable)
      .Get(receiptId)
      .RunResultAsync<PushNotificationReceiptEntity?>(connection);
  }

  public async Task<bool> TryCreatePushNotificationReceiptAsync(
    PushNotificationReceiptEntity receipt,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();

    try
    {
      await _r.Db(_db)
        .Table(PushNotificationReceiptTable)
        .Insert(JObject.FromObject(receipt))
        .OptArg("conflict", "error")
        .RunResultAsync<object>(connection);
      return true;
    }
    catch (Exception exception) when (IsReceiptConflictException(exception))
    {
      return false;
    }
  }

  public async Task UpsertPushNotificationReceiptAsync(
    PushNotificationReceiptEntity receipt,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(PushNotificationReceiptTable)
      .Insert(JObject.FromObject(receipt))
      .OptArg("conflict", "replace")
      .RunResultAsync<object>(connection);
  }

  public async Task DeletePushNotificationReceiptAsync(
    string receiptId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    await _r.Db(_db)
      .Table(PushNotificationReceiptTable)
      .Get(receiptId)
      .Delete()
      .RunResultAsync<object>(connection);
  }

  public async Task<JObject?> GetLogicalThreadIssueAsync(
    string userId,
    string bridgeId,
    string issueId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    var issues = await ReadTableRowsAsync(connection, LogicalThreadIssueBoardTable);
    return issues.FirstOrDefault(issue =>
      string.Equals(issue.Value<string>("login_id") ?? issue.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
      string.Equals(issue.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
      string.Equals(issue.Value<string>("id"), issueId, StringComparison.Ordinal) &&
      string.IsNullOrWhiteSpace(issue.Value<string>("deleted_at")));
  }

  public async Task<JObject?> GetSourceThreadIssueAsync(
    string userId,
    string bridgeId,
    string issueId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    var issues = await ReadTableRowsAsync(connection, ThreadIssueCardTable);
    return issues.FirstOrDefault(issue =>
      string.Equals(issue.Value<string>("login_id") ?? issue.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
      string.Equals(issue.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
      string.Equals(issue.Value<string>("id"), issueId, StringComparison.Ordinal) &&
      string.IsNullOrWhiteSpace(issue.Value<string>("deleted_at")));
  }

  public async Task<JObject?> GetProjectAsync(
    string userId,
    string bridgeId,
    string projectId,
    CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var connection = await GetConnectionAsync();
    var projects = await ReadTableRowsAsync(connection, ProjectTable);
    return projects.FirstOrDefault(project =>
      string.Equals(project.Value<string>("id"), projectId, StringComparison.Ordinal) &&
      string.Equals(project.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal));
  }

  private static bool IsReceiptConflictException(Exception exception)
  {
    var typeName = exception.GetType().Name;
    var message = exception.Message ?? string.Empty;

    if (typeName is not ("ReqlRuntimeError" or "ReqlOpFailedError" or "ReqlQueryLogicError"))
    {
      return false;
    }

    return message.Contains("primary key", StringComparison.OrdinalIgnoreCase) ||
      message.Contains("duplicate", StringComparison.OrdinalIgnoreCase) ||
      message.Contains("conflict", StringComparison.OrdinalIgnoreCase);
  }
}
