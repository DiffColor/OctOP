using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Features;
using Newtonsoft.Json.Linq;
using OctOP.Gateway;
using OctOP.ServerShared;

var builder = WebApplication.CreateBuilder(args);

var gatewayHost = Environment.GetEnvironmentVariable("OCTOP_GATEWAY_HOST") ?? "0.0.0.0";
var gatewayPort = int.TryParse(Environment.GetEnvironmentVariable("OCTOP_GATEWAY_PORT"), out var parsedPort)
  ? parsedPort
  : 4000;
var natsUrl = Environment.GetEnvironmentVariable("OCTOP_NATS_URL") ?? "nats://ilysrv.ddns.net:4222";
var corsOrigins = (Environment.GetEnvironmentVariable("OCTOP_DASHBOARD_ORIGIN")
    ?? "https://octop.pages.dev,https://octop.ilycode.app")
  .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
var licenseHubApiBaseUrl =
  Environment.GetEnvironmentVariable("OCTOP_LICENSEHUB_API_BASE_URL") ?? "https://licensehub.ilycode.app";
var allowedOriginSet = corsOrigins.ToHashSet(StringComparer.OrdinalIgnoreCase);

builder.WebHost.UseUrls($"http://{gatewayHost}:{gatewayPort}");
builder.Services.AddHttpClient();
builder.Services.AddSingleton(_ => new BridgeNatsClient(natsUrl));
builder.Services.AddSingleton<OctopStore>();

var app = builder.Build();
app.UseExceptionHandler(errorApp =>
{
  errorApp.Run(async httpContext =>
  {
    var exception = httpContext.Features.Get<IExceptionHandlerFeature>()?.Error;
    httpContext.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
    httpContext.Response.ContentType = "application/json; charset=utf-8";
    await httpContext.Response.WriteAsync(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = exception?.Message ?? "gateway unavailable"
      }));
  });
});
app.Use(async (httpContext, next) =>
{
  var origin = httpContext.Request.Headers.Origin.ToString();

  if (!string.IsNullOrWhiteSpace(origin) && allowedOriginSet.Contains(origin))
  {
    httpContext.Response.Headers.AccessControlAllowOrigin = origin;
    httpContext.Response.Headers.AccessControlAllowMethods = "GET,POST,PATCH,DELETE,OPTIONS";
    httpContext.Response.Headers.AccessControlAllowHeaders = "content-type,authorization";
    httpContext.Response.Headers.Append("Vary", "Origin");
  }

  if (HttpMethods.IsOptions(httpContext.Request.Method))
  {
    httpContext.Response.StatusCode = StatusCodes.Status204NoContent;
    return;
  }

  await next();
});

app.MapGet("/health", () =>
{
  return Results.Json(new Dictionary<string, object?>
  {
    ["ok"] = true,
    ["service"] = "octop-gateway"
  });
});

app.MapPost("/api/auth/login", async (HttpContext httpContext, IHttpClientFactory httpClientFactory, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);

  using var request = new HttpRequestMessage(HttpMethod.Post, $"{licenseHubApiBaseUrl}/api/auth/login")
  {
    Content = new StringContent(
      new JsonObject
      {
        ["loginId"] = body?["loginId"]?.GetValue<string>(),
        ["password"] = body?["password"]?.GetValue<string>()
      }.ToJsonString(),
      Encoding.UTF8,
      "application/json")
  };

  using var response = await httpClientFactory.CreateClient().SendAsync(request, cancellationToken);
  var content = await response.Content.ReadAsStringAsync(cancellationToken);
  var contentType = response.Content.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";

  if (!response.IsSuccessStatusCode)
  {
    return Results.Text(content, contentType, statusCode: (int)response.StatusCode);
  }

  var payload = JObject.Parse(content);
  var userId = payload.Value<string>("userId");
  var loginId = body?["loginId"]?.GetValue<string>() ?? string.Empty;

  if (!string.IsNullOrWhiteSpace(userId))
  {
    try
    {
      var normalizedLoginId = BridgeSubjects.SanitizeUserId(loginId);
      await octopStore.UpsertUserAsync(new JObject
      {
        ["id"] = normalizedLoginId,
        ["user_id"] = normalizedLoginId,
        ["login_id"] = normalizedLoginId,
        ["licensehub_user_id"] = BridgeSubjects.SanitizeUserId(userId),
        ["display_name"] = payload.Value<string>("displayName") ?? loginId,
        ["role"] = payload.Value<string>("role") ?? "viewer",
        ["is_active"] = payload.Value<bool?>("isActive") ?? true,
        ["last_login_at"] = DateTimeOffset.UtcNow.ToString("O")
      });
    }
    catch (Exception exception)
    {
      app.Logger.LogWarning(exception, "OctOP user sync failed for {UserId}", userId);
    }
  }

  return Results.Text(content, contentType, statusCode: StatusCodes.Status200OK);
});

app.MapGet("/api/bridges", async (HttpContext httpContext, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  cancellationToken.ThrowIfCancellationRequested();
  var bridges = await octopStore.ListBridgesForUserAsync(userId);
  return Results.Text(new JObject { ["bridges"] = bridges }.ToString(), "application/json; charset=utf-8");
});

app.MapGet("/api/projects", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"projects\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectsGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"projects\":[]}",
    "application/json; charset=utf-8");
});

app.MapGet("/api/workspace-roots", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"roots\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.WorkspaceRootsGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId
    },
    cancellationToken
  );

  return Results.Text(payload?.ToJsonString() ?? "{\"roots\":[]}", "application/json; charset=utf-8");
});

app.MapGet("/api/folders", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"entries\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.FolderListGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      path = httpContext.Request.Query["path"].ToString()
    },
    cancellationToken
  );

  return Results.Text(payload?.ToJsonString() ?? "{\"entries\":[]}", "application/json; charset=utf-8");
});

app.MapPost("/api/projects", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"accepted\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectCreate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      name = body?["name"]?.GetValue<string>(),
      key = body?["key"]?.GetValue<string>(),
      description = body?["description"]?.GetValue<string>(),
      workspace_path = body?["workspace_path"]?.GetValue<string>()
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status201Created : StatusCodes.Status400BadRequest
  );
});

app.MapPatch("/api/projects/{projectId}", async (
  string projectId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"accepted\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectUpdate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      project_id = projectId,
      name = body?["name"]?.GetValue<string>()
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status400BadRequest
  );
});

app.MapDelete("/api/projects/{projectId}", async (
  string projectId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectDelete,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      project_id = projectId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status400BadRequest
  );
});

app.MapGet("/api/threads", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);
  var projectId = httpContext.Request.Query["project_id"].ToString();

  if (bridgeId is null)
  {
    return Results.Text("{\"threads\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadsGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      project_id = projectId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"threads\":[]}",
    "application/json; charset=utf-8");
});

app.MapGet("/api/threads/{threadId}", async (
  string threadId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"thread\":null,\"messages\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadDetailGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"thread\":null,\"messages\":[]}",
    "application/json; charset=utf-8");
});

app.MapGet("/api/bridge/status", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.StatusGet,
    new { user_id = userId, bridge_id = bridgeId },
    cancellationToken);

  return Results.Text(payload?.ToJsonString() ?? "{}", "application/json; charset=utf-8");
});

app.MapPost("/api/commands/ping", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var projectId = body?["project_id"]?.GetValue<string>();

  if (!string.IsNullOrWhiteSpace(projectId))
  {
    await octopStore.EnsureProjectMembershipAsync(userId, bridgeId, projectId);
  }

  var payload = await bridgeNatsClient.RequestAsync(
    subjects.PingStart,
    new
    {
      user_id = userId,
      bridge_id = bridgeId,
      title = body?["title"]?.GetValue<string>(),
      prompt = body?["prompt"]?.GetValue<string>(),
      project_id = projectId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/issues", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var projectId = body?["project_id"]?.GetValue<string>();

  if (!string.IsNullOrWhiteSpace(projectId))
  {
    await octopStore.EnsureProjectMembershipAsync(userId, bridgeId, projectId);
  }

  var payload = await bridgeNatsClient.RequestAsync(
    subjects.IssueCreate,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      title = body?["title"]?.GetValue<string>(),
      prompt = body?["prompt"]?.GetValue<string>(),
      project_id = projectId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/threads/start", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var threadIds = body?["thread_ids"]?.AsArray()
    .Select(node => node?.GetValue<string>())
    .Where(value => !string.IsNullOrWhiteSpace(value))
    .Cast<string>()
    .ToArray() ?? [];

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadsStart,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_ids = threadIds
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/threads/reorder", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var threadIds = body?["thread_ids"]?.AsArray()
    .Select(node => node?.GetValue<string>())
    .Where(value => !string.IsNullOrWhiteSpace(value))
    .Cast<string>()
    .ToArray() ?? [];

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadsReorder,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_ids = threadIds
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
});

app.MapDelete("/api/threads/{threadId}", async (
  string threadId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"accepted\":false,\"error\":\"bridge not found\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status404NotFound);
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadDelete,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status400BadRequest
  );
});

app.MapGet("/api/events", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
  httpContext.Response.Headers.ContentType = "text/event-stream; charset=utf-8";
  httpContext.Response.Headers.CacheControl = "no-cache, no-transform";
  httpContext.Response.Headers.Connection = "keep-alive";

  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    await httpContext.Response.WriteAsync("event: error\ndata: {\"message\":\"bridge not found\"}\n\n", cancellationToken);
    await httpContext.Response.Body.FlushAsync(cancellationToken);
    return;
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var writeLock = new SemaphoreSlim(1, 1);

  async Task WriteEventAsync(string name, string payload)
  {
    await writeLock.WaitAsync(cancellationToken);
    try
    {
      await httpContext.Response.WriteAsync($"event: {name}\ndata: {payload}\n\n", cancellationToken);
      await httpContext.Response.Body.FlushAsync(cancellationToken);
    }
    finally
    {
      writeLock.Release();
    }
  }

  using var subscription = bridgeNatsClient.Subscribe(subjects.Events, (_, args) =>
  {
    var payload = BridgeNatsClient.Decode(args.Message);
    _ = Task.Run(() => WriteEventAsync("message", payload), CancellationToken.None);
  });

  await WriteEventAsync("ready", JsonSerializer.Serialize(new Dictionary<string, string>
  {
    ["user_id"] = userId,
    ["bridge_id"] = bridgeId
  }));

  try
  {
    var snapshot = await bridgeNatsClient.RequestAsync(
      subjects.StatusGet,
      new { user_id = userId, bridge_id = bridgeId },
      cancellationToken);

    if (snapshot is not null)
    {
      await WriteEventAsync("snapshot", snapshot.ToJsonString());
    }
  }
  catch (Exception exception)
  {
    await WriteEventAsync("error", JsonSerializer.Serialize(new Dictionary<string, object?>
    {
      ["message"] = exception.Message,
      ["user_id"] = userId,
      ["bridge_id"] = bridgeId
    }));
  }

  using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));

  try
  {
    while (await timer.WaitForNextTickAsync(cancellationToken))
    {
      await WriteEventAsync("heartbeat", JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        ["bridge_id"] = bridgeId
      }));
    }
  }
  catch (OperationCanceledException)
  {
  }
});

app.Run();

static async Task<string?> ResolveBridgeIdAsync(
  HttpContext httpContext,
  OctopStore octopStore,
  string userId,
  CancellationToken cancellationToken)
{
  var requested = BridgeSubjects.SanitizeBridgeId(httpContext.Request.Query["bridge_id"].ToString());

  if (!string.IsNullOrWhiteSpace(httpContext.Request.Query["bridge_id"]))
  {
    return requested;
  }

  cancellationToken.ThrowIfCancellationRequested();
  var bridges = await octopStore.ListBridgesForUserAsync(userId);
  return bridges.OfType<JObject>().FirstOrDefault()?.Value<string>("bridge_id");
}

static string ResolveIdentityKey(HttpContext httpContext)
{
  var loginId = httpContext.Request.Query["login_id"].ToString();

  if (!string.IsNullOrWhiteSpace(loginId))
  {
    return BridgeSubjects.SanitizeUserId(loginId);
  }

  return BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
}
