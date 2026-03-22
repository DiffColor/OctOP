using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Lib.Net.Http.WebPush;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Mvc;
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
    ?? "https://octop-admin.pages.dev,https://octop.turtlelab.app,https://octop-mobile.pages.dev,https://octop-m.turtlelab.app")
  .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
var licenseHubApiBaseUrl =
  Environment.GetEnvironmentVariable("OCTOP_LICENSEHUB_API_BASE_URL") ?? "https://licensehub.ilycode.app";
var allowedOriginSet = corsOrigins.ToHashSet(StringComparer.OrdinalIgnoreCase);

builder.WebHost.UseUrls($"http://{gatewayHost}:{gatewayPort}");
builder.Services.AddHttpClient();
builder.Services.AddSingleton<PushServiceClient>();
builder.Services.AddSingleton(_ => new BridgeNatsClient(natsUrl));
builder.Services.AddSingleton<OctopStore>();
builder.Services.AddSingleton<GatewayAttachmentStore>();
builder.Services.AddSingleton<VapidKeyService>();
builder.Services.AddSingleton<PushSubscriptionService>();
builder.Services.AddSingleton<WebPushNotificationService>();
builder.Services.AddSingleton<PushNotificationTemplateService>();
builder.Services.AddHostedService<PushNotificationEventMonitorService>();

var app = builder.Build();
app.UseExceptionHandler(errorApp =>
{
  errorApp.Run(async httpContext =>
  {
    var exception = httpContext.Features.Get<IExceptionHandlerFeature>()?.Error;
    var statusCode = StatusCodes.Status503ServiceUnavailable;
    var errorCode = "gateway_unavailable";
    var detail = exception?.Message ?? "gateway unavailable";
    Dictionary<string, object?>? meta = null;

    if (exception is BridgeNatsRequestException bridgeException)
    {
      errorCode = bridgeException.Code;
      detail = bridgeException.Message;
      meta = new Dictionary<string, object?>
      {
        ["subject"] = bridgeException.Subject,
        ["timeout_ms"] = bridgeException.TimeoutMs,
        ["inner_error"] = bridgeException.InnerException?.GetType().Name
      };
      statusCode = bridgeException.Code == "bridge_timeout"
        ? StatusCodes.Status504GatewayTimeout
        : StatusCodes.Status503ServiceUnavailable;
    }

    httpContext.Response.StatusCode = statusCode;
    httpContext.Response.ContentType = "application/json; charset=utf-8";
    await httpContext.Response.WriteAsync(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = detail,
        ["code"] = errorCode,
        ["meta"] = meta
      }));
  });
});
app.Use(async (httpContext, next) =>
{
  var origin = httpContext.Request.Headers.Origin.ToString();

  if (!string.IsNullOrWhiteSpace(origin) && allowedOriginSet.Contains(origin))
  {
    httpContext.Response.Headers.AccessControlAllowOrigin = origin;
    httpContext.Response.Headers.AccessControlAllowMethods = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
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
app.Use(async (httpContext, next) =>
{
  try
  {
    await next();
  }
  catch (OperationCanceledException) when (httpContext.RequestAborted.IsCancellationRequested)
  {
    if (!httpContext.Response.HasStarted)
    {
      httpContext.Response.StatusCode = 499;
    }
  }
  catch (JsonException exception)
  {
    if (httpContext.Response.HasStarted)
    {
      throw;
    }

    httpContext.Response.StatusCode = StatusCodes.Status400BadRequest;
    httpContext.Response.ContentType = "application/json; charset=utf-8";
    await httpContext.Response.WriteAsync(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = "invalid json body",
        ["code"] = "invalid_json",
        ["meta"] = new Dictionary<string, object?>
        {
          ["method"] = httpContext.Request.Method,
          ["path"] = httpContext.Request.Path.Value,
          ["detail"] = exception.Message
        }
      }));
  }
  catch (BridgeNatsRequestException exception)
  {
    if (httpContext.Response.HasStarted)
    {
      throw;
    }

    httpContext.Response.StatusCode = ResolveBridgeNatsStatusCode(exception);
    httpContext.Response.ContentType = "application/json; charset=utf-8";
    await httpContext.Response.WriteAsync(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = exception.Message,
        ["code"] = exception.Code,
        ["meta"] = new Dictionary<string, object?>
        {
          ["method"] = httpContext.Request.Method,
          ["path"] = httpContext.Request.Path.Value,
          ["subject"] = exception.Subject,
          ["timeout_ms"] = exception.TimeoutMs,
          ["inner_error"] = exception.InnerException?.GetType().Name
        }
      }));
  }
});

app.MapGet("/health", () =>
{
  return Results.Json(new Dictionary<string, object?>
  {
    ["ok"] = true,
    ["service"] = "octop-gateway"
  });
});

app.MapPost("/api/attachments", async (
  HttpContext httpContext,
  [FromForm] GatewayAttachmentUploadRequest request,
  GatewayAttachmentStore attachmentStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = BridgeSubjects.SanitizeBridgeId(httpContext.Request.Query["bridge_id"].ToString());
  var file = request.File;

  if (file is null || file.Length <= 0)
  {
    return Results.Text(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = "attachment file is required",
        ["code"] = "attachment_file_required"
      }),
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }

  if (file.Length > GatewayAttachmentStore.MaxAttachmentBytes)
  {
    return Results.Text(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = "attachment is too large",
        ["code"] = "attachment_too_large",
        ["max_bytes"] = GatewayAttachmentStore.MaxAttachmentBytes
      }),
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status413PayloadTooLarge);
  }

  GatewayAttachmentRecord record;

  try
  {
    await using var stream = file.OpenReadStream();
    record = await attachmentStore.SaveAsync(userId, bridgeId, file.FileName, file.ContentType, stream, cancellationToken);
  }
  catch (InvalidOperationException exception) when (string.Equals(exception.Message, "attachment_too_large", StringComparison.Ordinal))
  {
    return Results.Text(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = "attachment is too large",
        ["code"] = "attachment_too_large",
        ["max_bytes"] = GatewayAttachmentStore.MaxAttachmentBytes
      }),
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status413PayloadTooLarge);
  }

  var apiBaseUrl = ResolvePublicApiBaseUrl(httpContext);
  var downloadUrl = $"{apiBaseUrl}/api/attachments/{Uri.EscapeDataString(record.UploadId)}?token={Uri.EscapeDataString(record.DownloadToken)}";
  var cleanupUrl = $"{apiBaseUrl}/api/attachments/{Uri.EscapeDataString(record.UploadId)}?cleanup_token={Uri.EscapeDataString(record.CleanupToken)}";

  return Results.Text(
    new JsonObject
    {
      ["attachment"] = new JsonObject
      {
        ["upload_id"] = record.UploadId,
        ["download_url"] = downloadUrl,
        ["cleanup_url"] = cleanupUrl,
        ["uploaded_at"] = record.UploadedAt,
        ["name"] = record.FileName,
        ["mime_type"] = record.ContentType,
        ["size_bytes"] = record.SizeBytes
      }
    }.ToJsonString(),
    "application/json; charset=utf-8",
    statusCode: StatusCodes.Status201Created);
});

app.MapGet("/api/attachments/{uploadId}", async (
  string uploadId,
  HttpContext httpContext,
  GatewayAttachmentStore attachmentStore,
  CancellationToken cancellationToken) =>
{
  var token = httpContext.Request.Query["token"].ToString();
  var record = await attachmentStore.GetAsync(uploadId, cancellationToken);

  if (record is null || !string.Equals(record.DownloadToken, token, StringComparison.Ordinal))
  {
    return Results.NotFound();
  }

  var filePath = attachmentStore.GetFilePath(record);

  if (!File.Exists(filePath))
  {
    return Results.NotFound();
  }

  httpContext.Response.Headers.CacheControl = "private, max-age=300";
  return Results.File(filePath, record.ContentType, fileDownloadName: record.FileName);
});

app.MapDelete("/api/attachments/{uploadId}", async (
  string uploadId,
  HttpContext httpContext,
  GatewayAttachmentStore attachmentStore,
  CancellationToken cancellationToken) =>
{
  var cleanupToken = httpContext.Request.Query["cleanup_token"].ToString();

  if (string.IsNullOrWhiteSpace(cleanupToken))
  {
    return Results.NotFound();
  }

  var deleted = await attachmentStore.DeleteAsync(uploadId, cleanupToken, cancellationToken);
  return deleted ? Results.NoContent() : Results.NotFound();
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

app.MapDelete("/api/bridges/{bridgeId}", async (
  string bridgeId,
  HttpContext httpContext,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var normalizedBridgeId = BridgeSubjects.SanitizeBridgeId(bridgeId);

  if (string.IsNullOrWhiteSpace(normalizedBridgeId))
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  cancellationToken.ThrowIfCancellationRequested();

  if (!await octopStore.UserOwnsBridgeAsync(userId, normalizedBridgeId))
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  await octopStore.DeleteBridgeForUserAsync(userId, normalizedBridgeId);
  var bridges = await octopStore.ListBridgesForUserAsync(userId);

  return Results.Text(
    new JObject
    {
      ["ok"] = true,
      ["deleted_bridge_id"] = normalizedBridgeId,
      ["bridges"] = bridges
    }.ToString(),
    "application/json; charset=utf-8");
});

app.MapGet("/api/dashboard/archives", async (HttpContext httpContext, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  cancellationToken.ThrowIfCancellationRequested();
  var archives = await octopStore.GetDashboardArchivesAsync(userId);
  httpContext.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
  httpContext.Response.Headers.Pragma = "no-cache";
  return Results.Text(
    new JsonObject
    {
      ["archives"] = ConvertJTokenToJsonNode(archives) ?? new JsonObject()
    }.ToJsonString(),
    "application/json; charset=utf-8");
});

app.MapPut("/api/dashboard/archives", async (HttpContext httpContext, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var archives = NormalizeDashboardArchiveState(body?["archives"] ?? body);

  await octopStore.UpsertDashboardArchivesAsync(userId, JObject.Parse(archives.ToJsonString()));
  httpContext.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
  httpContext.Response.Headers.Pragma = "no-cache";

  return Results.Text(
    new JsonObject
    {
      ["ok"] = true,
      ["archives"] = archives
    }.ToJsonString(),
    "application/json; charset=utf-8");
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

app.MapGet("/api/todo/chats", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"chats\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.TodoChatsGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"chats\":[]}",
    "application/json; charset=utf-8");
});

app.MapPost("/api/todo/chats", async (HttpContext httpContext, BridgeNatsClient bridgeNatsClient, OctopStore octopStore, CancellationToken cancellationToken) =>
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
    subjects.TodoChatCreate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      title = body?["title"]?.GetValue<string>()
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

app.MapPatch("/api/todo/chats/{chatId}", async (
  string chatId,
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
    subjects.TodoChatUpdate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_chat_id = chatId,
      title = body?["title"]?.GetValue<string>()
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

app.MapDelete("/api/todo/chats/{chatId}", async (
  string chatId,
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

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.TodoChatDelete,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_chat_id = chatId
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

app.MapGet("/api/todo/chats/{chatId}/messages", async (
  string chatId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"chat\":null,\"messages\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.TodoMessagesGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_chat_id = chatId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"chat\":null,\"messages\":[]}",
    "application/json; charset=utf-8");
});

app.MapPost("/api/todo/chats/{chatId}/messages", async (
  string chatId,
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
    subjects.TodoMessageCreate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_chat_id = chatId,
      content = body?["content"]?.GetValue<string>()
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

app.MapPatch("/api/todo/messages/{messageId}", async (
  string messageId,
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
    subjects.TodoMessageUpdate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_message_id = messageId,
      content = body?["content"]?.GetValue<string>()
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

app.MapDelete("/api/todo/messages/{messageId}", async (
  string messageId,
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

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.TodoMessageDelete,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_message_id = messageId
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

app.MapPost("/api/todo/messages/{messageId}/transfer", async (
  string messageId,
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
  var projectId = body?["project_id"]?.GetValue<string>();

  if (!string.IsNullOrWhiteSpace(projectId))
  {
    await octopStore.EnsureProjectMembershipAsync(userId, bridgeId, projectId);
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.TodoMessageTransfer,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      todo_message_id = messageId,
      project_id = projectId,
      thread_mode = body?["thread_mode"]?.GetValue<string>(),
      thread_id = body?["thread_id"]?.GetValue<string>(),
      thread_name = body?["thread_name"]?.GetValue<string>()
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
  var requestedKey = body?["key"]?.GetValue<string>();
  var normalizedKey = string.IsNullOrWhiteSpace(requestedKey) ? null : requestedKey;
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectCreate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      name = body?["name"]?.GetValue<string>(),
      key = normalizedKey,
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
      name = body?["name"]?.GetValue<string>(),
      base_instructions = body?["base_instructions"]?.GetValue<string>(),
      developer_instructions = body?["developer_instructions"]?.GetValue<string>(),
      update_base_instructions = body?["update_base_instructions"]?.GetValue<bool?>() ?? false,
      update_developer_instructions = body?["update_developer_instructions"]?.GetValue<bool?>() ?? false
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

app.MapGet("/api/projects/{projectId}/threads", async (
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
    return Results.Text("{\"threads\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadsGet,
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

app.MapPost("/api/projects/{projectId}/threads", async (
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

  await octopStore.EnsureProjectMembershipAsync(userId, bridgeId, projectId);
  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadCreate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      project_id = projectId,
      name = body?["name"]?.GetValue<string>(),
      description = body?["description"]?.GetValue<string>()
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

app.MapPatch("/api/threads/{threadId}", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var requestedDeveloperInstructionsUpdate = body?["update_developer_instructions"]?.GetValue<bool?>() ?? false;

  if (requestedDeveloperInstructionsUpdate)
  {
    var statusPayload = await GetBridgeStatusPayloadAsync(bridgeNatsClient, userId, bridgeId, cancellationToken);

    if (!BridgeSupportsCapability(statusPayload, "thread_developer_instructions"))
    {
      return BuildUnsupportedBridgeFeatureResult(
        bridgeId,
        statusPayload,
        "thread_developer_instructions",
        "connected bridge does not support thread developer instructions update");
    }
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadUpdate,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      name = body?["name"]?.GetValue<string>(),
      developer_instructions = body?["developer_instructions"]?.GetValue<string>(),
      update_developer_instructions = body?["update_developer_instructions"]?.GetValue<bool?>() ?? false
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
    subjects.ProjectThreadDelete,
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

app.MapGet("/api/threads/{threadId}/issues", async (
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
    return Results.Text("{\"issues\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssuesGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId
    },
    cancellationToken
  );

  var rootThreadId = ResolveRootThreadId(threadId, payload);
  var projectionIssues = await octopStore.ListLogicalThreadIssueBoardAsync(userId, bridgeId, rootThreadId);
  var mergedPayload = MergeThreadIssuesPayload(payload, projectionIssues);

  return Results.Text(
    mergedPayload.ToJsonString(),
    "application/json; charset=utf-8");
});

app.MapGet("/api/threads/{threadId}/timeline", async (
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
    return Results.Text("{\"thread\":null,\"entries\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadTimelineGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId
    },
    cancellationToken
  );

  var rootThreadId = ResolveRootThreadId(threadId, payload);
  var projectionEntries = await octopStore.ListLogicalThreadTimelineAsync(userId, bridgeId, rootThreadId);
  var mergedPayload = MergeThreadTimelinePayload(payload, projectionEntries);

  return Results.Text(
    mergedPayload.ToJsonString(),
    "application/json; charset=utf-8");
});

app.MapGet("/api/threads/{threadId}/continuity", async (
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
    return Results.Text("{\"root_thread\":null,\"physical_threads\":[],\"handoff_summaries\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadContinuityGet,
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
    payload?.ToJsonString() ?? "{\"root_thread\":null,\"physical_threads\":[],\"handoff_summaries\":[]}",
    "application/json; charset=utf-8");
});

app.MapPost("/api/threads/{threadId}/issues", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssueCreate,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      title = body?["title"]?.GetValue<string>(),
      prompt = body?["prompt"]?.GetValue<string>(),
      attachments = body?["attachments"],
      source_app_id = body?["source_app_id"]?.GetValue<string>()
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status201Created : StatusCodes.Status502BadGateway
  );
});

app.MapGet("/api/issues/{issueId}", async (
  string issueId,
  HttpContext httpContext,
  BridgeNatsClient bridgeNatsClient,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text("{\"issue\":null,\"messages\":[]}", "application/json; charset=utf-8");
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssueDetailGet,
    new
    {
      login_id = userId,
      user_id = userId,
      bridge_id = bridgeId,
      issue_id = issueId
    },
    cancellationToken
  );

  return Results.Text(
    payload?.ToJsonString() ?? "{\"issue\":null,\"messages\":[]}",
    "application/json; charset=utf-8");
});

app.MapPatch("/api/issues/{issueId}", async (
  string issueId,
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssueUpdate,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      issue_id = issueId,
      title = body?["title"]?.GetValue<string>(),
      prompt = body?["prompt"]?.GetValue<string>(),
      attachments = body?["attachments"]
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status502BadGateway
  );
});

app.MapDelete("/api/issues/{issueId}", async (
  string issueId,
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
    subjects.ThreadIssueDelete,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      issue_id = issueId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? true;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/issues/{issueId}/interrupt", async (
  string issueId,
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssueInterrupt,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      issue_id = issueId,
      reason = body?["reason"]?.GetValue<string>() ?? "manual_interrupt"
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/issues/{issueId}/move", async (
  string issueId,
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var targetThreadId = body?["target_thread_id"]?.GetValue<string>();

  if (string.IsNullOrWhiteSpace(targetThreadId))
  {
    return Results.Text("{\"accepted\":false,\"error\":\"target_thread_id is required\"}", "application/json; charset=utf-8", statusCode: StatusCodes.Status400BadRequest);
  }

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssueMove,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      issue_id = issueId,
      target_thread_id = targetThreadId
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status200OK : StatusCodes.Status502BadGateway
  );
});

app.MapPost("/api/threads/{threadId}/issues/start", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var issueIds = body?["issue_ids"]?.AsArray()
    .Select(node => node?.GetValue<string>())
    .Where(value => !string.IsNullOrWhiteSpace(value))
    .Cast<string>()
    .ToArray() ?? [];

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssuesStart,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      issue_ids = issueIds
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

app.MapPost("/api/threads/{threadId}/issues/reorder", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var issueIds = body?["issue_ids"]?.AsArray()
    .Select(node => node?.GetValue<string>())
    .Where(value => !string.IsNullOrWhiteSpace(value))
    .Cast<string>()
    .ToArray() ?? [];
  var stage = body?["stage"]?.GetValue<string>()?.Trim();

  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ThreadIssuesReorder,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      issue_ids = issueIds,
      stage = stage
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

app.MapPost("/api/threads/{threadId}/rollover", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadRollover,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      reason = body?["reason"]?.GetValue<string>() ?? "manual"
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status400BadRequest
  );
});

app.MapPost("/api/threads/{threadId}/normalize", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadNormalize,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      reason = body?["reason"]?.GetValue<string>() ?? "manual_refresh"
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status400BadRequest
  );
});

app.MapPost("/api/threads/{threadId}/unlock", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadUnlock,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      reason = body?["reason"]?.GetValue<string>() ?? "manual_unlock"
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status400BadRequest
  );
});

app.MapPost("/api/threads/{threadId}/stop", async (
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

  var body = await JsonNode.ParseAsync(httpContext.Request.Body, cancellationToken: cancellationToken);
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  var payload = await bridgeNatsClient.RequestAsync(
    subjects.ProjectThreadStop,
    new
    {
      user_id = userId,
      login_id = userId,
      bridge_id = bridgeId,
      thread_id = threadId,
      reason = body?["reason"]?.GetValue<string>() ?? "manual_stop"
    },
    cancellationToken
  );

  var accepted = payload?["accepted"]?.GetValue<bool?>() ?? false;
  return Results.Text(
    payload?.ToJsonString() ?? "{}",
    "application/json; charset=utf-8",
    statusCode: accepted ? StatusCodes.Status202Accepted : StatusCodes.Status502BadGateway
  );
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
    new { user_id = userId, bridge_id = bridgeId, ensure_ready = false },
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

app.MapGet("/api/push/config", async (
  HttpContext httpContext,
  PushSubscriptionService pushSubscriptionService,
  PushNotificationTemplateService pushNotificationTemplateService,
  VapidKeyService vapidKeyService,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);
  var appId = ResolvePushAppId(httpContext);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"enabled\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  if (string.IsNullOrWhiteSpace(appId))
  {
    return Results.Text(
      "{\"enabled\":false,\"error\":\"app_id is required\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }

  var count = vapidKeyService.IsConfigured
    ? await pushSubscriptionService.GetCountAsync(userId, bridgeId, appId, cancellationToken)
    : 0;

  return Results.Json(new PushConfigResponse
  {
    Enabled = vapidKeyService.IsConfigured,
    PublicVapidKey = vapidKeyService.PublicKey,
    AppId = appId,
    BridgeId = bridgeId,
    SubscriptionCount = count,
    Templates = pushNotificationTemplateService.CreateSnapshot()
  });
});

app.MapGet("/api/push/subscriptions", async (
  HttpContext httpContext,
  PushSubscriptionService pushSubscriptionService,
  VapidKeyService vapidKeyService,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);
  var appId = ResolvePushAppId(httpContext);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"enabled\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  if (string.IsNullOrWhiteSpace(appId))
  {
    return Results.Text(
      "{\"enabled\":false,\"error\":\"app_id is required\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }

  var endpoints = vapidKeyService.IsConfigured
    ? await pushSubscriptionService.GetEndpointsAsync(userId, bridgeId, appId, cancellationToken)
    : [];

  return Results.Json(new PushSubscriptionSummaryResponse
  {
    Enabled = vapidKeyService.IsConfigured,
    Count = endpoints.Count,
    Endpoints = endpoints
  });
});

app.MapPost("/api/push/subscriptions", async (
  PushSubscriptionDto subscription,
  HttpContext httpContext,
  PushSubscriptionService pushSubscriptionService,
  VapidKeyService vapidKeyService,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  if (!vapidKeyService.IsConfigured)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"push is not configured\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status503ServiceUnavailable);
  }

  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);
  var appId = ResolvePushAppId(httpContext);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  if (string.IsNullOrWhiteSpace(appId))
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"app_id is required\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }

  try
  {
    var count = await pushSubscriptionService.UpsertAsync(
      userId,
      bridgeId,
      appId,
      httpContext.Request.Headers.Origin.ToString(),
      subscription,
      httpContext.Request.Headers.UserAgent.ToString(),
      cancellationToken);

    return Results.Json(new Dictionary<string, object?>
    {
      ["ok"] = true,
      ["count"] = count
    }, statusCode: StatusCodes.Status201Created);
  }
  catch (ArgumentException exception)
  {
    return Results.Text(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = exception.Message
      }),
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }
});

app.MapDelete("/api/push/subscriptions", async (
  [FromBody] PushSubscriptionDeleteRequest request,
  HttpContext httpContext,
  PushSubscriptionService pushSubscriptionService,
  VapidKeyService vapidKeyService,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  if (!vapidKeyService.IsConfigured)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"push is not configured\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status503ServiceUnavailable);
  }

  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);
  var appId = ResolvePushAppId(httpContext);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  if (string.IsNullOrWhiteSpace(appId))
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"app_id is required\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }

  try
  {
    var count = await pushSubscriptionService.DeleteAsync(
      userId,
      bridgeId,
      appId,
      request.Endpoint,
      cancellationToken);

    return Results.Json(new Dictionary<string, object?>
    {
      ["ok"] = true,
      ["count"] = count
    });
  }
  catch (ArgumentException exception)
  {
    return Results.Text(
      JsonSerializer.Serialize(new Dictionary<string, object?>
      {
        ["ok"] = false,
        ["error"] = exception.Message
      }),
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status400BadRequest);
  }
});

app.MapPost("/api/push/send", async (
  PushNotificationRequest request,
  HttpContext httpContext,
  PushSubscriptionService pushSubscriptionService,
  WebPushNotificationService webPushNotificationService,
  PushNotificationTemplateService pushNotificationTemplateService,
  VapidKeyService vapidKeyService,
  OctopStore octopStore,
  CancellationToken cancellationToken) =>
{
  if (!vapidKeyService.IsConfigured)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"push is not configured\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status503ServiceUnavailable);
  }

  var userId = ResolveIdentityKey(httpContext);
  var bridgeId = await ResolveBridgeIdAsync(httpContext, octopStore, userId, cancellationToken);

  if (bridgeId is null)
  {
    return Results.Text(
      "{\"ok\":false,\"error\":\"bridge not found\"}",
      "application/json; charset=utf-8",
      statusCode: StatusCodes.Status404NotFound);
  }

  var subscriptions = await pushSubscriptionService.GetActiveSubscriptionsAsync(userId, bridgeId, cancellationToken);
  var response = await webPushNotificationService.SendAsync(
    subscriptions,
    (subscription) => pushNotificationTemplateService.BuildManualNotification(request, bridgeId, subscription.AppId),
    cancellationToken);
  return Results.Json(response);
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
      new { user_id = userId, bridge_id = bridgeId, ensure_ready = false },
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
    return await octopStore.ResolveCanonicalBridgeIdForUserAsync(userId, requested) ?? requested;
  }

  cancellationToken.ThrowIfCancellationRequested();
  var bridges = await octopStore.ListBridgesForUserAsync(userId);
  return bridges.OfType<JObject>().FirstOrDefault()?.Value<string>("bridge_id");
}

static async Task<JsonNode?> GetBridgeStatusPayloadAsync(
  BridgeNatsClient bridgeNatsClient,
  string userId,
  string bridgeId,
  CancellationToken cancellationToken)
{
  var subjects = BridgeSubjects.ForUser(userId, bridgeId);
  return await bridgeNatsClient.RequestAsync(
    subjects.StatusGet,
    new { user_id = userId, bridge_id = bridgeId, ensure_ready = false },
    cancellationToken);
}

static bool BridgeSupportsCapability(JsonNode? statusPayload, string capability)
{
  return statusPayload?["capabilities"]?[capability]?.GetValue<bool?>() == true;
}

static IResult BuildUnsupportedBridgeFeatureResult(
  string bridgeId,
  JsonNode? statusPayload,
  string feature,
  string message)
{
  return Results.Text(
    JsonSerializer.Serialize(new Dictionary<string, object?>
    {
      ["accepted"] = false,
      ["error"] = message,
      ["code"] = "unsupported_bridge_feature",
      ["feature"] = feature,
      ["bridge_id"] = bridgeId,
      ["bridge_revision"] = GetStringValue(statusPayload?["bridge_revision"])
    }),
    "application/json; charset=utf-8",
    statusCode: StatusCodes.Status409Conflict);
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

static string ResolvePublicApiBaseUrl(HttpContext httpContext)
{
  var configured = Environment.GetEnvironmentVariable("OCTOP_PUBLIC_API_BASE_URL");

  if (!string.IsNullOrWhiteSpace(configured))
  {
    return configured.TrimEnd('/');
  }

  return $"{httpContext.Request.Scheme}://{httpContext.Request.Host.Value}".TrimEnd('/');
}

static string ResolvePushAppId(HttpContext httpContext)
{
  var appId = httpContext.Request.Query["app_id"].ToString();

  if (string.IsNullOrWhiteSpace(appId))
  {
    return string.Empty;
  }

  var chars = appId
    .Trim()
    .ToLowerInvariant()
    .Select(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' ? ch : '-')
    .ToArray();

  return new string(chars).Trim('-');
}

static int ResolveBridgeNatsStatusCode(BridgeNatsRequestException exception)
{
  return exception.Code switch
  {
    "bridge_timeout" => StatusCodes.Status504GatewayTimeout,
    "bridge_no_responders" => StatusCodes.Status503ServiceUnavailable,
    "bridge_transport_error" => StatusCodes.Status503ServiceUnavailable,
    _ => StatusCodes.Status502BadGateway
  };
}

static string ResolveRootThreadId(string fallbackThreadId, JsonNode? payload)
{
  return GetStringValue(payload?["continuity"]?["root_thread"]?["id"])
    ?? GetStringValue(payload?["thread"]?["id"])
    ?? fallbackThreadId;
}

static JsonObject MergeThreadIssuesPayload(JsonNode? bridgePayload, JArray projectionIssues)
{
  var result = bridgePayload?.DeepClone() as JsonObject ?? new JsonObject();
  var continuity = result["continuity"]?.DeepClone() as JsonObject;
  var bridgeIssues = result["issues"] as JsonArray ?? new JsonArray();
  var readSplit = ResolveReadSplitState(continuity, BuildProjectionIssueCoverage(projectionIssues));
  var preferredPhysicalThreadIds = readSplit.PreferredBridgePhysicalThreadIds;
  var mergedById = new Dictionary<string, JsonObject>(StringComparer.Ordinal);

  foreach (var projectionIssue in projectionIssues.OfType<JObject>())
  {
    var issueNode = ConvertJTokenToJsonNode(projectionIssue) as JsonObject;

    if (issueNode is null)
    {
      continue;
    }

    var issueId = GetStringValue(issueNode["id"]);

    if (string.IsNullOrWhiteSpace(issueId))
    {
      continue;
    }

    var physicalThreadId = ResolveIssuePhysicalThreadId(issueNode);

    if (string.IsNullOrWhiteSpace(physicalThreadId) || preferredPhysicalThreadIds.Contains(physicalThreadId))
    {
      continue;
    }

    mergedById[issueId] = issueNode;
  }

  foreach (var bridgeIssue in bridgeIssues.OfType<JsonObject>())
  {
    var issueNode = bridgeIssue.DeepClone() as JsonObject;

    if (issueNode is null)
    {
      continue;
    }

    var issueId = GetStringValue(issueNode["id"]);

    if (string.IsNullOrWhiteSpace(issueId))
    {
      continue;
    }

    var physicalThreadId = ResolveIssuePhysicalThreadId(issueNode);

    if (!mergedById.ContainsKey(issueId) || string.IsNullOrWhiteSpace(physicalThreadId) || preferredPhysicalThreadIds.Contains(physicalThreadId))
    {
      mergedById[issueId] = issueNode;
    }
  }

  var mergedIssues = mergedById.Values.ToList();
  mergedIssues.Sort(CompareIssueBoardEntries);

  result["thread"] = result["thread"]?.DeepClone() ?? continuity?["root_thread"]?.DeepClone();
  result["issues"] = new JsonArray(mergedIssues.Select(issue => (JsonNode)issue).ToArray());
  if (continuity is not null)
  {
    continuity["read_split"] = BuildReadSplitMetadata(readSplit);
  }
  result["continuity"] = continuity;
  return result;
}

static JsonObject MergeThreadTimelinePayload(JsonNode? bridgePayload, JArray projectionEntries)
{
  var result = bridgePayload?.DeepClone() as JsonObject ?? new JsonObject();
  var continuity = result["continuity"]?.DeepClone() as JsonObject;
  var bridgeEntries = result["entries"] as JsonArray ?? new JsonArray();
  var readSplit = ResolveReadSplitState(continuity, BuildProjectionTimelineCoverage(projectionEntries));
  var preferredPhysicalThreadIds = readSplit.PreferredBridgePhysicalThreadIds;
  var mergedByKey = new Dictionary<string, JsonObject>(StringComparer.Ordinal);

  foreach (var projectionEntry in projectionEntries.OfType<JObject>())
  {
    var entryNode = ConvertJTokenToJsonNode(projectionEntry) as JsonObject;

    if (entryNode is null)
    {
      continue;
    }

    var physicalThreadId = GetStringValue(entryNode["physical_thread_id"]);

    if (string.IsNullOrWhiteSpace(physicalThreadId) || preferredPhysicalThreadIds.Contains(physicalThreadId))
    {
      continue;
    }

    mergedByKey[BuildTimelineEntryKey(entryNode)] = entryNode;
  }

  foreach (var bridgeEntry in bridgeEntries.OfType<JsonObject>())
  {
    var entryNode = bridgeEntry.DeepClone() as JsonObject;

    if (entryNode is null)
    {
      continue;
    }

    var physicalThreadId = GetStringValue(entryNode["physical_thread_id"]);
    var entryKey = BuildTimelineEntryKey(entryNode);

    if (string.IsNullOrWhiteSpace(physicalThreadId) || preferredPhysicalThreadIds.Contains(physicalThreadId) || !mergedByKey.ContainsKey(entryKey))
    {
      mergedByKey[entryKey] = entryNode;
    }
  }

  var mergedEntries = mergedByKey.Values.ToList();
  mergedEntries.Sort(CompareTimelineEntries);

  result["thread"] = result["thread"]?.DeepClone() ?? continuity?["root_thread"]?.DeepClone();
  result["entries"] = new JsonArray(mergedEntries.Select(entry => (JsonNode)entry).ToArray());
  if (continuity is not null)
  {
    continuity["read_split"] = BuildReadSplitMetadata(readSplit);
  }
  result["continuity"] = continuity;
  return result;
}

static ReadSplitState ResolveReadSplitState(JsonNode? continuity, Dictionary<string, DateTimeOffset> projectionCoverage)
{
  var preferred = new HashSet<string>(StringComparer.Ordinal);
  var caughtUp = new HashSet<string>(StringComparer.Ordinal);
  var pending = new HashSet<string>(StringComparer.Ordinal);
  var activePhysicalThreadId = GetStringValue(continuity?["active_physical_thread"]?["id"]);

  if (!string.IsNullOrWhiteSpace(activePhysicalThreadId))
  {
    preferred.Add(activePhysicalThreadId);
  }

  if (continuity?["recently_closed_physical_threads"] is JsonArray recentlyClosed)
  {
    foreach (var item in recentlyClosed)
    {
      var physicalThreadId = GetStringValue(item?["physical_thread_id"]);
      var closedAt = ParseIsoTimestamp(GetStringValue(item?["closed_at"]));

      if (!string.IsNullOrWhiteSpace(physicalThreadId))
      {
        if (projectionCoverage.TryGetValue(physicalThreadId, out var projectedAt) && projectedAt >= closedAt)
        {
          caughtUp.Add(physicalThreadId);
          continue;
        }

        preferred.Add(physicalThreadId);
        pending.Add(physicalThreadId);
      }
    }
  }

  return new ReadSplitState(preferred, caughtUp, pending);
}

static string? ResolveIssuePhysicalThreadId(JsonNode? issueNode)
{
  return GetStringValue(issueNode?["executed_physical_thread_id"])
    ?? GetStringValue(issueNode?["created_physical_thread_id"]);
}

static int CompareIssueBoardEntries(JsonObject? left, JsonObject? right)
{
  var leftStatus = GetStringValue(left?["status"]) ?? string.Empty;
  var rightStatus = GetStringValue(right?["status"]) ?? string.Empty;

  if (string.Equals(leftStatus, "staged", StringComparison.Ordinal) && string.Equals(rightStatus, "staged", StringComparison.Ordinal))
  {
    var leftPrep = GetNullableInt(left?["prep_position"]);
    var rightPrep = GetNullableInt(right?["prep_position"]);
    var prepComparison = CompareOrderedIntegers(leftPrep, rightPrep);

    if (prepComparison != 0)
    {
      return prepComparison;
    }
  }

  if (string.Equals(leftStatus, "queued", StringComparison.Ordinal) && string.Equals(rightStatus, "queued", StringComparison.Ordinal))
  {
    var leftQueue = GetNullableInt(left?["queue_position"]);
    var rightQueue = GetNullableInt(right?["queue_position"]);
    var queueComparison = CompareOrderedIntegers(leftQueue, rightQueue);

    if (queueComparison != 0)
    {
      return queueComparison;
    }
  }

  return CompareIsoTimestampsDescending(GetStringValue(left?["updated_at"]), GetStringValue(right?["updated_at"]));
}

static int CompareTimelineEntries(JsonObject? left, JsonObject? right)
{
  var leftSequence = GetNullableInt(left?["physical_sequence"]) ?? int.MaxValue;
  var rightSequence = GetNullableInt(right?["physical_sequence"]) ?? int.MaxValue;

  if (leftSequence != rightSequence)
  {
    return leftSequence.CompareTo(rightSequence);
  }

  return CompareIsoTimestampsAscending(GetStringValue(left?["timestamp"]), GetStringValue(right?["timestamp"]));
}

static int CompareOrderedIntegers(int? left, int? right)
{
  var leftHasValue = left.HasValue;
  var rightHasValue = right.HasValue;
  var leftValue = left.GetValueOrDefault();
  var rightValue = right.GetValueOrDefault();

  if (leftHasValue && rightHasValue && leftValue != rightValue)
  {
    return leftValue.CompareTo(rightValue);
  }

  if (leftHasValue && !rightHasValue)
  {
    return -1;
  }

  if (!leftHasValue && rightHasValue)
  {
    return 1;
  }

  return 0;
}

static int CompareIsoTimestampsDescending(string? left, string? right)
{
  var leftValue = ParseIsoTimestamp(left);
  var rightValue = ParseIsoTimestamp(right);
  return rightValue.CompareTo(leftValue);
}

static int CompareIsoTimestampsAscending(string? left, string? right)
{
  var leftValue = ParseIsoTimestamp(left);
  var rightValue = ParseIsoTimestamp(right);
  return leftValue.CompareTo(rightValue);
}

static DateTimeOffset ParseIsoTimestamp(string? value)
{
  return DateTimeOffset.TryParse(value, out var parsed) ? parsed : DateTimeOffset.MinValue;
}

static Dictionary<string, DateTimeOffset> BuildProjectionIssueCoverage(JArray projectionIssues)
{
  var coverage = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);

  foreach (var issue in projectionIssues.OfType<JObject>())
  {
    var issueNode = ConvertJTokenToJsonNode(issue);
    var physicalThreadId = ResolveIssuePhysicalThreadId(issueNode);

    if (string.IsNullOrWhiteSpace(physicalThreadId))
    {
      continue;
    }

    var projectedAt = ParseIsoTimestamp(issue.Value<string>("projected_at"));

    if (!coverage.TryGetValue(physicalThreadId, out var currentProjectedAt) || projectedAt > currentProjectedAt)
    {
      coverage[physicalThreadId] = projectedAt;
    }
  }

  return coverage;
}

static Dictionary<string, DateTimeOffset> BuildProjectionTimelineCoverage(JArray projectionEntries)
{
  var coverage = new Dictionary<string, DateTimeOffset>(StringComparer.Ordinal);

  foreach (var entry in projectionEntries.OfType<JObject>())
  {
    var physicalThreadId = entry.Value<string>("physical_thread_id");

    if (string.IsNullOrWhiteSpace(physicalThreadId))
    {
      continue;
    }

    var projectedAt = ParseIsoTimestamp(entry.Value<string>("projected_at"));

    if (!coverage.TryGetValue(physicalThreadId, out var currentProjectedAt) || projectedAt > currentProjectedAt)
    {
      coverage[physicalThreadId] = projectedAt;
    }
  }

  return coverage;
}

static JsonObject BuildReadSplitMetadata(ReadSplitState state)
{
  return new JsonObject
  {
    ["active_source"] = "bridge",
    ["recently_closed_source"] = "bridge",
    ["closed_history_source"] = "projection",
    ["projection_catch_up_signal"] = "projected_at >= physical_thread.closed_at",
    ["projection_caught_up_physical_thread_ids"] = new JsonArray(state.CaughtUpPhysicalThreadIds.Select(id => (JsonNode)id).ToArray()),
    ["projection_pending_physical_thread_ids"] = new JsonArray(state.PendingProjectionPhysicalThreadIds.Select(id => (JsonNode)id).ToArray())
  };
}

static JsonObject NormalizeDashboardArchiveState(JsonNode? node)
{
  var normalized = new JsonObject();

  if (node is not JsonObject bridgeObject)
  {
    return normalized;
  }

  foreach (var (bridgeId, bridgeValue) in bridgeObject)
  {
    var normalizedBridgeId = GetStringValue(JsonValue.Create(bridgeId));

    if (string.IsNullOrWhiteSpace(normalizedBridgeId) || bridgeValue is not JsonObject threadObject)
    {
      continue;
    }

    var normalizedThreads = new JsonObject();

    foreach (var (threadId, idsNode) in threadObject)
    {
      var normalizedThreadId = GetStringValue(JsonValue.Create(threadId));

      if (string.IsNullOrWhiteSpace(normalizedThreadId))
      {
        continue;
      }

      JsonArray? idsArray = idsNode as JsonArray;
      string? updatedAt = null;

      if (idsNode is JsonObject entryObject)
      {
        idsArray = entryObject["issueIds"] as JsonArray
          ?? entryObject["ids"] as JsonArray
          ?? entryObject["issue_ids"] as JsonArray;
        updatedAt = GetStringValue(entryObject["updatedAt"] ?? entryObject["updated_at"]);
      }

      if (idsArray is null)
      {
        continue;
      }

      var normalizedIds = idsArray
        .Select(GetStringValue)
        .Where(id => !string.IsNullOrWhiteSpace(id))
        .Distinct(StringComparer.Ordinal)
        .Select(id => (JsonNode)JsonValue.Create(id)!)
        .ToArray();

      if (normalizedIds.Length == 0 && string.IsNullOrWhiteSpace(updatedAt))
      {
        continue;
      }

      normalizedThreads[normalizedThreadId] = new JsonObject
      {
        ["issueIds"] = new JsonArray(normalizedIds),
        ["updatedAt"] = updatedAt
      };
    }

    if (normalizedThreads.Count > 0)
    {
      normalized[normalizedBridgeId] = normalizedThreads;
    }
  }

  return normalized;
}

static int? GetNullableInt(JsonNode? node)
{
  if (node is null)
  {
    return null;
  }

  if (node.GetValueKind() == JsonValueKind.Number && node is JsonValue jsonValue && jsonValue.TryGetValue<int>(out var numericValue))
  {
    return numericValue;
  }

  var raw = GetStringValue(node);
  return int.TryParse(raw, out var parsed) ? parsed : null;
}

static string? GetStringValue(JsonNode? node)
{
  var value = node?.ToString()?.Trim();
  return string.IsNullOrWhiteSpace(value) ? null : value;
}

static JsonNode? ConvertJTokenToJsonNode(JToken? token)
{
  return token is null ? null : JsonNode.Parse(token.ToString(Newtonsoft.Json.Formatting.None));
}

static string BuildTimelineEntryKey(JsonObject entry)
{
  return string.Join(
    "|",
    GetStringValue(entry["physical_thread_id"]) ?? string.Empty,
    GetStringValue(entry["issue_id"]) ?? string.Empty,
    GetStringValue(entry["timestamp"]) ?? string.Empty,
    GetStringValue(entry["role"]) ?? string.Empty,
    GetStringValue(entry["kind"]) ?? string.Empty,
    GetStringValue(entry["content"]) ?? string.Empty
  );
}

sealed record ReadSplitState(
  HashSet<string> PreferredBridgePhysicalThreadIds,
  HashSet<string> CaughtUpPhysicalThreadIds,
  HashSet<string> PendingProjectionPhysicalThreadIds);
