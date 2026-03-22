using System.Security.Cryptography;
using System.Text.Json;

namespace OctOP.Gateway;

public sealed class GatewayAttachmentStore
{
  public const long MaxAttachmentBytes = 5L * 1024 * 1024;

  private readonly string _rootDirectory;

  public GatewayAttachmentStore()
  {
    var stateHome = Environment.GetEnvironmentVariable("OCTOP_STATE_HOME");

    if (string.IsNullOrWhiteSpace(stateHome))
    {
      stateHome = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".octop");
    }

    _rootDirectory = Path.Combine(stateHome, "gateway-attachments");
    Directory.CreateDirectory(_rootDirectory);
  }

  public async Task<GatewayAttachmentRecord> SaveAsync(
    string userId,
    string? bridgeId,
    string fileName,
    string? contentType,
    Stream source,
    CancellationToken cancellationToken)
  {
    var normalizedFileName = SanitizeFileName(fileName);
    var uploadId = CreateToken("gatt");
    var directoryPath = Path.Combine(_rootDirectory, uploadId);
    var filePath = Path.Combine(directoryPath, normalizedFileName);
    var uploadedAt = DateTimeOffset.UtcNow.ToString("O");

    Directory.CreateDirectory(directoryPath);

    long sizeBytes = 0;

    try
    {
      await using (var destination = File.Create(filePath))
      {
        var buffer = new byte[81920];

        while (true)
        {
          var bytesRead = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), cancellationToken);

          if (bytesRead <= 0)
          {
            break;
          }

          sizeBytes += bytesRead;

          if (sizeBytes > MaxAttachmentBytes)
          {
            throw new InvalidOperationException("attachment_too_large");
          }

          await destination.WriteAsync(buffer.AsMemory(0, bytesRead), cancellationToken);
        }
      }

      var record = new GatewayAttachmentRecord
      {
        UploadId = uploadId,
        UserId = userId,
        BridgeId = string.IsNullOrWhiteSpace(bridgeId) ? null : bridgeId,
        FileName = normalizedFileName,
        ContentType = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType.Trim(),
        SizeBytes = sizeBytes,
        UploadedAt = uploadedAt,
        DownloadToken = CreateToken("dl"),
        CleanupToken = CreateToken("cl")
      };

      await File.WriteAllTextAsync(
        GetMetadataPath(uploadId),
        JsonSerializer.Serialize(record),
        cancellationToken);

      return record;
    }
    catch
    {
      try
      {
        Directory.Delete(directoryPath, recursive: true);
      }
      catch
      {
        // noop
      }

      throw;
    }
  }

  public async Task<GatewayAttachmentRecord?> GetAsync(string uploadId, CancellationToken cancellationToken)
  {
    var metadataPath = GetMetadataPath(uploadId);

    if (!File.Exists(metadataPath))
    {
      return null;
    }

    var json = await File.ReadAllTextAsync(metadataPath, cancellationToken);
    return JsonSerializer.Deserialize<GatewayAttachmentRecord>(json);
  }

  public string GetFilePath(GatewayAttachmentRecord record)
  {
    return Path.Combine(_rootDirectory, record.UploadId, record.FileName);
  }

  public async Task<bool> DeleteAsync(string uploadId, string cleanupToken, CancellationToken cancellationToken)
  {
    var record = await GetAsync(uploadId, cancellationToken);

    if (record is null || !string.Equals(record.CleanupToken, cleanupToken, StringComparison.Ordinal))
    {
      return false;
    }

    var directoryPath = Path.Combine(_rootDirectory, record.UploadId);

    if (Directory.Exists(directoryPath))
    {
      Directory.Delete(directoryPath, recursive: true);
    }

    return true;
  }

  private string GetMetadataPath(string uploadId)
  {
    return Path.Combine(_rootDirectory, uploadId, "metadata.json");
  }

  private static string CreateToken(string prefix)
  {
    return $"{prefix}-{Convert.ToHexString(RandomNumberGenerator.GetBytes(16)).ToLowerInvariant()}";
  }

  private static string SanitizeFileName(string fileName)
  {
    var baseName = Path.GetFileName(string.IsNullOrWhiteSpace(fileName) ? "attachment" : fileName.Trim());
    var invalidChars = Path.GetInvalidFileNameChars().ToHashSet();
    var sanitized = new string(baseName.Select(ch => invalidChars.Contains(ch) ? '-' : ch).ToArray()).Trim();

    return string.IsNullOrWhiteSpace(sanitized) ? "attachment" : sanitized;
  }
}

public sealed class GatewayAttachmentRecord
{
  public string UploadId { get; init; } = string.Empty;
  public string UserId { get; init; } = string.Empty;
  public string? BridgeId { get; init; }
  public string FileName { get; init; } = "attachment";
  public string ContentType { get; init; } = "application/octet-stream";
  public long SizeBytes { get; init; }
  public string UploadedAt { get; init; } = string.Empty;
  public string DownloadToken { get; init; } = string.Empty;
  public string CleanupToken { get; init; } = string.Empty;
}
