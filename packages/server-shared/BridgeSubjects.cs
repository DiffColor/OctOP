namespace OctOP.ServerShared;

public sealed record BridgeSubjectSet(
  string BridgeId,
  string StatusGet,
  string ProjectsGet,
  string ProjectCreate,
  string WorkspaceRootsGet,
  string FolderListGet,
  string ThreadsGet,
  string PingStart,
  string Events
);

public static class BridgeSubjects
{
  public static string SanitizeUserId(string? userId = "local-user")
  {
    var normalized = string.IsNullOrWhiteSpace(userId) ? "local-user" : userId.Trim();
    var chars = normalized
      .Select(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' ? ch : '_')
      .ToArray();
    var sanitized = new string(chars);

    return string.IsNullOrWhiteSpace(sanitized) ? "local-user" : sanitized;
  }

  public static string SanitizeBridgeId(string? bridgeId = "local-bridge")
  {
    var normalized = string.IsNullOrWhiteSpace(bridgeId) ? "local-bridge" : bridgeId.Trim();
    var chars = normalized
      .Select(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' ? ch : '_')
      .ToArray();
    var sanitized = new string(chars);

    return string.IsNullOrWhiteSpace(sanitized) ? "local-bridge" : sanitized;
  }

  public static BridgeSubjectSet ForUser(string? userId, string? bridgeId = "local-bridge")
  {
    var uid = SanitizeUserId(userId);
    var bid = SanitizeBridgeId(bridgeId);
    var @base = $"octop.user.{uid}.bridge.{bid}";

    return new BridgeSubjectSet(
      BridgeId: bid,
      StatusGet: $"{@base}.status.get",
      ProjectsGet: $"{@base}.projects.get",
      ProjectCreate: $"{@base}.project.create",
      WorkspaceRootsGet: $"{@base}.workspace.roots.get",
      FolderListGet: $"{@base}.folder.list.get",
      ThreadsGet: $"{@base}.threads.get",
      PingStart: $"{@base}.command.ping",
      Events: $"octop.user.{uid}.bridge.{bid}.events"
    );
  }
}
