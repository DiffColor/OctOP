using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace OctOP.Gateway.Voice;

public sealed class VoiceNarrationService(IHttpClientFactory httpClientFactory)
{
  private readonly IHttpClientFactory _httpClientFactory = httpClientFactory;
  private readonly string _apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY") ?? string.Empty;
  private readonly string _model = Environment.GetEnvironmentVariable("OCTOP_OPENAI_TTS_MODEL") ?? "gpt-4o-mini-tts";
  private readonly string _voice = Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_VOICE") ?? "alloy";
  private readonly string _apiBaseUrl = (Environment.GetEnvironmentVariable("OCTOP_OPENAI_REALTIME_API_BASE_URL") ?? "https://api.openai.com").TrimEnd('/');

  public bool IsEnabled =>
    !string.Equals(Environment.GetEnvironmentVariable("OCTOP_VOICE_SESSION_ENABLED"), "false", StringComparison.OrdinalIgnoreCase);

  public async Task<JsonObject> CreateNarrationAsync(VoiceNarrationRequest request, CancellationToken cancellationToken)
  {
    if (!IsEnabled)
    {
      throw new InvalidOperationException("voice_narration_disabled");
    }

    if (string.IsNullOrWhiteSpace(_apiKey))
    {
      throw new InvalidOperationException("voice_session_api_key_missing");
    }

    var narration = request.Text?.Trim();

    if (string.IsNullOrWhiteSpace(narration))
    {
      throw new InvalidOperationException("voice_narration_text_required");
    }

    var payload = new JsonObject
    {
      ["model"] = _model,
      ["voice"] = _voice,
      ["input"] = narration
    };

    using var httpRequest = new HttpRequestMessage(HttpMethod.Post, $"{_apiBaseUrl}/v1/audio/speech")
    {
      Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json")
    };
    httpRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _apiKey);

    using var response = await _httpClientFactory.CreateClient().SendAsync(httpRequest, cancellationToken);

    if (!response.IsSuccessStatusCode)
    {
      var errorContent = await response.Content.ReadAsStringAsync(cancellationToken);
      throw new InvalidOperationException($"voice_narration_openai_error:{errorContent}");
    }

    var audioBytes = await response.Content.ReadAsByteArrayAsync(cancellationToken);
    var contentType = response.Content.Headers.ContentType?.MediaType?.Trim();

    return new JsonObject
    {
      ["ok"] = true,
      ["audio_base64"] = Convert.ToBase64String(audioBytes),
      ["content_type"] = string.IsNullOrWhiteSpace(contentType) ? "audio/mpeg" : contentType,
      ["model"] = _model,
      ["voice"] = _voice
    };
  }
}
