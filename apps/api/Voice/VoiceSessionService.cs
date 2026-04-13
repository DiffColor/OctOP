using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OctOP.Gateway.Voice;

public sealed class VoiceSessionService(IHttpClientFactory httpClientFactory, VoicePromptBuilder promptBuilder)
{
  private readonly IHttpClientFactory _httpClientFactory = httpClientFactory;
  private readonly VoicePromptBuilder _promptBuilder = promptBuilder;
  private readonly string _apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY") ?? string.Empty;
  private readonly string _model = Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_MODEL") ?? "gpt-realtime";
  private readonly string _voice = Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_VOICE") ?? "alloy";
  private readonly string _apiBaseUrl = (Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_API_BASE_URL") ?? "https://api.openai.com").TrimEnd('/');
  private readonly int _ttlSeconds = int.TryParse(Environment.GetEnvironmentVariable("OCTOP_VOICE_SESSION_TTL_SECONDS"), out var ttlSeconds)
    ? Math.Clamp(ttlSeconds, 60, 3600)
    : 600;

  public bool IsEnabled =>
    !string.Equals(Environment.GetEnvironmentVariable("OCTOP_VOICE_SESSION_ENABLED"), "false", StringComparison.OrdinalIgnoreCase);

  public async Task<JsonObject> CreateClientSecretAsync(VoiceSessionStartRequest request, CancellationToken cancellationToken)
  {
    if (!IsEnabled)
    {
      throw new InvalidOperationException("voice_session_disabled");
    }

    if (string.IsNullOrWhiteSpace(_apiKey))
    {
      throw new InvalidOperationException("voice_session_api_key_missing");
    }

    var payload = new JsonObject
    {
      ["expires_after"] = new JsonObject
      {
        ["anchor"] = "created_at",
        ["seconds"] = _ttlSeconds
      },
      ["session"] = BuildSessionConfig(request)
    };

    using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{_apiBaseUrl}/v1/realtime/client_secrets")
    {
      Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
    };
    httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

    using var response = await _httpClientFactory.CreateClient().SendAsync(httpRequest, cancellationToken);
    var content = await response.Content.ReadAsStringAsync(cancellationToken);

    if (!response.IsSuccessStatusCode)
    {
      throw new InvalidOperationException($"voice_session_openai_error:{content}");
    }

    var parsed = JsonNode.Parse(content) as JsonObject
      ?? throw new InvalidOperationException("voice_session_openai_invalid_response");

    parsed["call_url"] = $"{_apiBaseUrl}/v1/realtime/calls";
    return parsed;
  }

  private JsonObject BuildSessionConfig(VoiceSessionStartRequest request)
  {
    return new JsonObject
    {
      ["type"] = "realtime",
      ["model"] = _model,
      ["instructions"] = _promptBuilder.BuildInstructions(request),
      ["tool_choice"] = "auto",
      ["tools"] = _promptBuilder.BuildTools(),
      ["audio"] = new JsonObject
      {
        ["input"] = new JsonObject
        {
          ["noise_reduction"] = new JsonObject
          {
            ["type"] = "near_field"
          },
          ["transcription"] = new JsonObject
          {
            ["model"] = "gpt-4o-mini-transcribe",
            ["language"] = "ko"
          },
          ["turn_detection"] = new JsonObject
          {
            ["type"] = "server_vad",
            ["interrupt_response"] = true,
            ["create_response"] = true,
            ["silence_duration_ms"] = 550,
            ["prefix_padding_ms"] = 250
          }
        },
        ["output"] = new JsonObject
        {
          ["voice"] = _voice
        }
      }
    };
  }
}
