namespace OctOP.ServerShared;

public sealed record BridgeSubjectSet(
  string BridgeId,
  string StatusGet,
  string ProjectsGet,
  string ProjectCreate,
  string ProjectDelete,
  string WorkspaceRootsGet,
  string FolderListGet,
  string ThreadsGet,
  string ThreadsReorder,
  string ThreadDetailGet,
  string ThreadDelete,
  string IssueCreate,
  string ThreadsStart,
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
      ProjectDelete: $"{@base}.project.delete",
      WorkspaceRootsGet: $"{@base}.workspace.roots.get",
      FolderListGet: $"{@base}.folder.list.get",
      ThreadsGet: $"{@base}.threads.get",
      ThreadsReorder: $"{@base}.threads.reorder",
      ThreadDetailGet: $"{@base}.thread.detail.get",
      ThreadDelete: $"{@base}.thread.delete",
      IssueCreate: $"{@base}.issue.create",
      ThreadsStart: $"{@base}.threads.start",
      PingStart: $"{@base}.command.ping",
      Events: $"octop.user.{uid}.bridge.{bid}.events"
    );
  }
}
