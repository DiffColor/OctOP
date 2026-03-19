using Lib.Net.Http.WebPush;
using Lib.Net.Http.WebPush.Authentication;

namespace OctOP.Gateway;

public sealed class VapidKeyService
{
  public VapidKeyService()
  {
    PublicKey = Environment.GetEnvironmentVariable("OCTOP_PUSH_VAPID_PUBLIC_KEY")?.Trim() ?? string.Empty;
    PrivateKey = Environment.GetEnvironmentVariable("OCTOP_PUSH_VAPID_PRIVATE_KEY")?.Trim() ?? string.Empty;
    Subject = Environment.GetEnvironmentVariable("OCTOP_PUSH_VAPID_SUBJECT")?.Trim() ?? string.Empty;
  }

  public string PublicKey { get; }

  public string PrivateKey { get; }

  public string Subject { get; }

  public bool IsConfigured =>
    !string.IsNullOrWhiteSpace(PublicKey) &&
    !string.IsNullOrWhiteSpace(PrivateKey) &&
    !string.IsNullOrWhiteSpace(Subject);

  public VapidAuthentication CreateAuthentication()
  {
    if (!IsConfigured)
    {
      throw new InvalidOperationException("push vapid keys are not configured");
    }

    return new VapidAuthentication(PublicKey, PrivateKey)
    {
      Subject = Subject
    };
  }
}
