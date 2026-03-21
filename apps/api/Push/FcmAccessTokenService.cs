using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OctOP.Gateway;

public sealed class FcmAccessTokenService(IHttpClientFactory httpClientFactory)
{
  private readonly SemaphoreSlim _tokenLock = new(1, 1);
  private string? _cachedAccessToken;
  private DateTimeOffset _expiresAt = DateTimeOffset.MinValue;

  public string ProjectId => LoadSettings().ProjectId;

  public bool IsConfigured => !string.IsNullOrWhiteSpace(ProjectId) && !string.IsNullOrWhiteSpace(LoadSettings().ClientEmail);

  public async Task<string> GetAccessTokenAsync(CancellationToken cancellationToken)
  {
    await _tokenLock.WaitAsync(cancellationToken);
    try
    {
      if (!string.IsNullOrWhiteSpace(_cachedAccessToken) && _expiresAt > DateTimeOffset.UtcNow.AddMinutes(5))
      {
        return _cachedAccessToken;
      }

      var settings = LoadSettings();
      var assertion = CreateAssertion(settings);
      using var request = new HttpRequestMessage(HttpMethod.Post, settings.TokenUri)
      {
        Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
          ["grant_type"] = "urn:ietf:params:oauth:grant-type:jwt-bearer",
          ["assertion"] = assertion
        })
      };

      using var response = await httpClientFactory.CreateClient().SendAsync(request, cancellationToken);
      var content = await response.Content.ReadAsStringAsync(cancellationToken);

      if (!response.IsSuccessStatusCode)
      {
        throw new InvalidOperationException($"FCM access token 요청 실패: {(int)response.StatusCode} {content}");
      }

      using var document = JsonDocument.Parse(content);
      _cachedAccessToken = document.RootElement.GetProperty("access_token").GetString();
      var expiresIn = document.RootElement.GetProperty("expires_in").GetInt32();
      _expiresAt = DateTimeOffset.UtcNow.AddSeconds(expiresIn);

      if (string.IsNullOrWhiteSpace(_cachedAccessToken))
      {
        throw new InvalidOperationException("FCM access token 응답이 비어 있습니다.");
      }

      return _cachedAccessToken;
    }
    finally
    {
      _tokenLock.Release();
    }
  }

  private static string CreateAssertion(FcmServiceAccountSettings settings)
  {
    var issuedAt = DateTimeOffset.UtcNow;
    var expiresAt = issuedAt.AddMinutes(55);
    var header = SerializeBase64Url(new Dictionary<string, object?>
    {
      ["alg"] = "RS256",
      ["typ"] = "JWT"
    });
    var payload = SerializeBase64Url(new Dictionary<string, object?>
    {
      ["iss"] = settings.ClientEmail,
      ["scope"] = "https://www.googleapis.com/auth/firebase.messaging",
      ["aud"] = settings.TokenUri,
      ["iat"] = issuedAt.ToUnixTimeSeconds(),
      ["exp"] = expiresAt.ToUnixTimeSeconds()
    });
    var unsignedToken = $"{header}.{payload}";
    using var rsa = RSA.Create();
    rsa.ImportFromPem(settings.PrivateKey.ToCharArray());
    var signature = rsa.SignData(Encoding.UTF8.GetBytes(unsignedToken), HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
    return $"{unsignedToken}.{Base64UrlEncode(signature)}";
  }

  private static string SerializeBase64Url(object value)
  {
    return Base64UrlEncode(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)));
  }

  private static string Base64UrlEncode(byte[] value)
  {
    return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  }

  private static FcmServiceAccountSettings LoadSettings()
  {
    var inlineJson = Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_SERVICE_ACCOUNT_JSON")?.Trim();
    var filePath = Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_SERVICE_ACCOUNT_FILE")?.Trim();
    var rawJson = !string.IsNullOrWhiteSpace(inlineJson)
      ? inlineJson
      : !string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath)
        ? File.ReadAllText(filePath)
        : string.Empty;

    if (string.IsNullOrWhiteSpace(rawJson))
    {
      return new FcmServiceAccountSettings();
    }

    using var document = JsonDocument.Parse(rawJson);
    var root = document.RootElement;
    var projectIdFromEnv = Environment.GetEnvironmentVariable("OCTOP_PUSH_FCM_PROJECT_ID")?.Trim();
    var projectIdFromJson = root.TryGetProperty("project_id", out var projectId)
      ? projectId.GetString() ?? string.Empty
      : string.Empty;
    return new FcmServiceAccountSettings
    {
      ProjectId = !string.IsNullOrWhiteSpace(projectIdFromEnv) ? projectIdFromEnv : projectIdFromJson,
      ClientEmail = root.TryGetProperty("client_email", out var clientEmail) ? clientEmail.GetString() ?? string.Empty : string.Empty,
      PrivateKey = (root.TryGetProperty("private_key", out var privateKey) ? privateKey.GetString() ?? string.Empty : string.Empty)
        .Replace("\\n", "\n"),
      TokenUri = root.TryGetProperty("token_uri", out var tokenUri)
        ? tokenUri.GetString() ?? "https://oauth2.googleapis.com/token"
        : "https://oauth2.googleapis.com/token"
    };
  }

  private sealed class FcmServiceAccountSettings
  {
    public string ProjectId { get; set; } = string.Empty;

    public string ClientEmail { get; set; } = string.Empty;

    public string PrivateKey { get; set; } = string.Empty;

    public string TokenUri { get; set; } = "https://oauth2.googleapis.com/token";
  }
}
