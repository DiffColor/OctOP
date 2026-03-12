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
    var bridges = await _r.Db(_db).Table(BridgeNodeTable).RunResultAsync<JArray>(connection);

    return new JArray(
      bridges
        .OfType<JObject>()
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
    var memberships = await _r.Db(_db).Table(ProjectMemberTable).RunResultAsync<JArray>(connection);
    var projectIds = memberships
      .OfType<JObject>()
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

    var projects = await _r.Db(_db).Table(ProjectTable).RunResultAsync<JArray>(connection);

    return new JArray(
      projects
        .OfType<JObject>()
        .Where(project =>
          string.Equals(project.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal) &&
          projectIds.Contains(project.Value<string>("id") ?? string.Empty))
        .OrderBy(project => project.Value<string>("name"))
    );
  }

  public async Task<JArray> ListThreadsAsync(string userId, string bridgeId, string? projectId)
  {
    var connection = await GetConnectionAsync();
    var threads = await _r.Db(_db).Table(ThreadTable).RunResultAsync<JArray>(connection);

    return new JArray(
      threads
        .OfType<JObject>()
        .Where(thread =>
          string.Equals(thread.Value<string>("login_id") ?? thread.Value<string>("user_id"), userId, StringComparison.Ordinal) &&
          string.Equals(thread.Value<string>("bridge_id"), bridgeId, StringComparison.Ordinal))
        .Where(thread => string.IsNullOrWhiteSpace(projectId) || string.Equals(thread.Value<string>("project_id"), projectId, StringComparison.Ordinal))
        .OrderByDescending(thread => DateTimeOffset.TryParse(thread.Value<string>("updated_at"), out var updatedAt) ? updatedAt : DateTimeOffset.MinValue)
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
}
