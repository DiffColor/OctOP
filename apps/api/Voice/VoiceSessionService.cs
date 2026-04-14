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

    try
    {
      var payload = new JsonObject
      {
        ["expires_after"] = new JsonObject
        {
          ["anchor"] = "created_at",
          ["seconds"] = _ttlSeconds
        },
        ["session"] = BuildSessionConfig(request)
      };

      using var httpRequest = new HttpRequestMessage(HttpMethod.Post, OpenAiApiUrlResolver.ResolveRealtimeApiUrl("/realtime/client_secrets"))
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

      parsed["call_url"] = OpenAiApiUrlResolver.ResolveRealtimeApiUrl("/realtime/calls");
      return parsed;
    }
    catch (OperationCanceledException)
    {
      throw;
    }
    catch (InvalidOperationException exception) when (
      exception.Message.StartsWith("voice_session_", StringComparison.Ordinal))
    {
      throw;
    }
    catch (Exception exception)
    {
      throw new InvalidOperationException(
        $"voice_session_openai_request_failed:{exception.GetType().Name}:{exception.Message}",
        exception);
    }
  }

  private JsonObject BuildSessionConfig(VoiceSessionStartRequest request)
  {
    return new JsonObject
    {
      ["type"] = "realtime",
      ["model"] = _model,
      ["instructions"] = _promptBuilder.BuildInstructions(request),
      ["tools"] = BuildRealtimeTools(),
      ["tool_choice"] = "auto",
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
            ["language"] = "ko",
            ["prompt"] = _promptBuilder.BuildTranscriptionPrompt(request)
          },
          ["turn_detection"] = new JsonObject
          {
            ["type"] = "server_vad",
            ["interrupt_response"] = true,
            ["create_response"] = false,
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

  private static JsonArray BuildRealtimeTools()
  {
    return new JsonArray
    {
      new JsonObject
      {
        ["type"] = "function",
        ["name"] = "delegate_to_app_server",
        ["description"] = "사용자 요청을 현재 쓰레드의 app-server 작업으로 전달합니다. 구현, 수정, 조사, 실행, 질문 해결이 필요하면 먼저 이 함수를 호출합니다.",
        ["parameters"] = new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject
          {
            ["prompt"] = new JsonObject
            {
              ["type"] = "string",
              ["description"] = "현재 쓰레드에 app-server로 전달할 사용자 요청의 핵심 프롬프트입니다."
            }
          },
          ["required"] = new JsonArray("prompt")
        }
      },
      new JsonObject
      {
        ["type"] = "function",
        ["name"] = "get_thread_status",
        ["description"] = "현재 쓰레드의 실행 상태와 활성 이슈 진행 상황을 조회합니다. 사용자가 진행 상황이나 현재 상태를 물을 때 사용합니다.",
        ["parameters"] = new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject()
        }
      },
      new JsonObject
      {
        ["type"] = "function",
        ["name"] = "interrupt_active_issue",
        ["description"] = "현재 쓰레드에서 실행 중인 작업을 중단합니다. 사용자가 멈춰 달라고 하거나 취소를 요청할 때 사용합니다.",
        ["parameters"] = new JsonObject
        {
          ["type"] = "object",
          ["properties"] = new JsonObject
          {
            ["reason"] = new JsonObject
            {
              ["type"] = "string",
              ["description"] = "중단 이유를 짧게 적습니다."
            }
          }
        }
      }
    };
  }
}
