using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http.Features;
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

builder.WebHost.UseUrls($"http://{gatewayHost}:{gatewayPort}");
builder.Services.AddCors(options =>
{
  options.AddDefaultPolicy(policy =>
  {
    policy.WithOrigins(corsOrigins).AllowAnyHeader().AllowAnyMethod();
  });
});
builder.Services.AddHttpClient();
builder.Services.AddSingleton(new BridgeNatsClient(natsUrl));

var app = builder.Build();

app.UseCors();

app.MapGet("/health", () =>
{
  return Results.Json(new Dictionary<string, object?>
  {
    ["ok"] = true,
    ["service"] = "octop-gateway"
  });
});

app.MapPost("/api/auth/login", async (HttpContext httpContext, IHttpClientFactory httpClientFactory, CancellationToken cancellationToken) =>
{
  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);

  return await ProxyJsonAsync(
    httpClientFactory.CreateClient(),
    $"{licenseHubApiBaseUrl}/api/auth/login",
    HttpMethod.Post,
    new JsonObject
    {
      ["loginId"] = body?["loginId"]?.GetValue<string>(),
      ["password"] = body?["password"]?.GetValue<string>()
    },
    null,
    cancellationToken
  );
});

app.MapGet("/api/bridge/status", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, CancellationToken cancellationToken) =>
{
  var userId = BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
  var subjects = BridgeSubjects.ForUser(userId);
  var payload = await bridgeNatsClient.RequestAsync(subjects.StatusGet, new { user_id = userId }, cancellationToken);
  return Results.Text(payload?.ToJsonString() ?? "{}", "application/json; charset=utf-8");
});

app.MapGet("/api/projects", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, CancellationToken cancellationToken) =>
{
  var userId = BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
  var subjects = BridgeSubjects.ForUser(userId);
  var payload = await bridgeNatsClient.RequestAsync(subjects.ProjectsGet, new { user_id = userId }, cancellationToken);
  return Results.Text(payload?.ToJsonString() ?? "{\"projects\":[]}", "application/json; charset=utf-8");
});

app.MapGet("/api/threads", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, CancellationToken cancellationToken) =>
{
  var userId = BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
  var subjects = BridgeSubjects.ForUser(userId);
  var payload = await bridgeNatsClient.RequestAsync(subjects.ThreadsGet, new { user_id = userId }, cancellationToken);
  return Results.Text(payload?.ToJsonString() ?? "{\"threads\":[]}", "application/json; charset=utf-8");
});

app.MapPost("/api/commands/ping", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, CancellationToken cancellationToken) =>
{
  var userId = BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
  var subjects = BridgeSubjects.ForUser(userId);
  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.PingStart,
    new
    {
      user_id = userId,
      title = body?["title"]?.GetValue<string>(),
      prompt = body?["prompt"]?.GetValue<string>(),
      project_id = body?["project_id"]?.GetValue<string>()
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

app.MapGet("/api/events", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, CancellationToken cancellationToken) =>
{
  httpContext.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
  httpContext.Response.Headers.ContentType = "text/event-stream; charset=utf-8";
  httpContext.Response.Headers.CacheControl = "no-cache, no-transform";
  httpContext.Response.Headers.Connection = "keep-alive";

  var userId = BridgeSubjects.SanitizeUserId(httpContext.Request.Query["user_id"].ToString());
  var subjects = BridgeSubjects.ForUser(userId);
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

  await WriteEventAsync("ready", JsonSerializer.Serialize(new Dictionary<string, string> { ["user_id"] = userId }));

  try
  {
    var snapshot = await bridgeNatsClient.RequestAsync(subjects.StatusGet, new { user_id = userId }, cancellationToken);

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
      ["user_id"] = userId
    }));
  }

  using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));

  try
  {
    while (await timer.WaitForNextTickAsync(cancellationToken))
    {
      await WriteEventAsync("heartbeat", JsonSerializer.Serialize(new Dictionary<string, long>
      {
        ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
      }));
    }
  }
  catch (OperationCanceledException)
  {
  }
});

app.Run();

static async Task<IResult> ProxyJsonAsync(
  HttpClient httpClient,
  string url,
  HttpMethod method,
  JsonNode? body,
  string? authorization,
  CancellationToken cancellationToken)
{
  using var request = new HttpRequestMessage(method, url);

  if (!string.IsNullOrWhiteSpace(authorization))
  {
    request.Headers.TryAddWithoutValidation("Authorization", authorization);
  }

  if (body is not null)
  {
    request.Content = new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json");
  }

  using var response = await httpClient.SendAsync(request, cancellationToken);
  var content = await response.Content.ReadAsStringAsync(cancellationToken);
  var contentType = response.Content.Headers.ContentType?.ToString() ?? "application/json; charset=utf-8";

  return Results.Text(content, contentType, statusCode: (int)response.StatusCode);
}
