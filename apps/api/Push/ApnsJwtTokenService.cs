using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace OctOP.Gateway;

public sealed class ApnsJwtTokenService
{
  private readonly SemaphoreSlim _tokenLock = new(1, 1);
  private string? _cachedToken;
  private DateTimeOffset _issuedAt = DateTimeOffset.MinValue;

  public bool IsConfigured => !string.IsNullOrWhiteSpace(KeyId) && !string.IsNullOrWhiteSpace(TeamId) && !string.IsNullOrWhiteSpace(PrivateKey);

  public string KeyId => Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_KEY_ID")?.Trim() ?? string.Empty;

  public string TeamId => Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_TEAM_ID")?.Trim() ?? string.Empty;

  public string DefaultTopic => Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_DEFAULT_TOPIC")?.Trim() ?? string.Empty;

  public bool UseSandbox =>
    string.Equals(Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_USE_SANDBOX")?.Trim(), "true", StringComparison.OrdinalIgnoreCase);

  public async Task<string> GetTokenAsync(CancellationToken cancellationToken)
  {
    await _tokenLock.WaitAsync(cancellationToken);
    try
    {
      if (!string.IsNullOrWhiteSpace(_cachedToken) && _issuedAt > DateTimeOffset.UtcNow.AddMinutes(-50))
      {
        return _cachedToken;
      }

      var issuedAt = DateTimeOffset.UtcNow;
      var header = SerializeBase64Url(new Dictionary<string, object?>
      {
        ["alg"] = "ES256",
        ["kid"] = KeyId
      });
      var payload = SerializeBase64Url(new Dictionary<string, object?>
      {
        ["iss"] = TeamId,
        ["iat"] = issuedAt.ToUnixTimeSeconds()
      });
      var unsignedToken = $"{header}.{payload}";
      using var ecdsa = ECDsa.Create();
      ecdsa.ImportFromPem(PrivateKey.ToCharArray());
      var signature = ecdsa.SignData(
        Encoding.UTF8.GetBytes(unsignedToken),
        HashAlgorithmName.SHA256,
        DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
      _cachedToken = $"{unsignedToken}.{Base64UrlEncode(signature)}";
      _issuedAt = issuedAt;
      return _cachedToken;
    }
    finally
    {
      _tokenLock.Release();
    }
  }

  private string PrivateKey
  {
    get
    {
      var inline = Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_PRIVATE_KEY")?.Trim();

      if (!string.IsNullOrWhiteSpace(inline))
      {
        return inline.Replace("\\n", "\n");
      }

      var filePath = Environment.GetEnvironmentVariable("OCTOP_PUSH_APNS_PRIVATE_KEY_FILE")?.Trim();
      return !string.IsNullOrWhiteSpace(filePath) && File.Exists(filePath)
        ? File.ReadAllText(filePath)
        : string.Empty;
    }
  }

  private static string SerializeBase64Url(object value)
  {
    return Base64UrlEncode(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value)));
  }

  private static string Base64UrlEncode(byte[] value)
  {
    return Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
  }
}
