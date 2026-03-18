namespace OctOP.ServerShared;

public sealed record BridgeSubjectSet(
  string BridgeId,
  string StatusGet,
  string ProjectsGet,
  string TodoChatsGet,
  string TodoChatCreate,
  string TodoChatUpdate,
  string TodoChatDelete,
  string TodoMessagesGet,
  string TodoMessageCreate,
  string TodoMessageUpdate,
  string TodoMessageDelete,
  string TodoMessageTransfer,
  string ProjectCreate,
  string ProjectUpdate,
  string ProjectDelete,
  string WorkspaceRootsGet,
  string FolderListGet,
  string ProjectThreadsGet,
  string ProjectThreadCreate,
  string ProjectThreadUpdate,
  string ProjectThreadDelete,
  string ProjectThreadRollover,
  string ProjectThreadNormalize,
  string ProjectThreadUnlock,
  string ProjectThreadStop,
  string ThreadTimelineGet,
  string ThreadContinuityGet,
  string ThreadIssuesGet,
  string ThreadIssueCreate,
  string ThreadIssueDetailGet,
  string ThreadIssueDelete,
  string ThreadIssueInterrupt,
  string ThreadIssueMove,
  string ThreadIssueUpdate,
  string ThreadIssuesStart,
  string ThreadIssuesReorder,
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
      TodoChatsGet: $"{@base}.todo.chats.get",
      TodoChatCreate: $"{@base}.todo.chat.create",
      TodoChatUpdate: $"{@base}.todo.chat.update",
      TodoChatDelete: $"{@base}.todo.chat.delete",
      TodoMessagesGet: $"{@base}.todo.messages.get",
      TodoMessageCreate: $"{@base}.todo.message.create",
      TodoMessageUpdate: $"{@base}.todo.message.update",
      TodoMessageDelete: $"{@base}.todo.message.delete",
      TodoMessageTransfer: $"{@base}.todo.message.transfer",
      ProjectCreate: $"{@base}.project.create",
      ProjectUpdate: $"{@base}.project.update",
      ProjectDelete: $"{@base}.project.delete",
      WorkspaceRootsGet: $"{@base}.workspace.roots.get",
      FolderListGet: $"{@base}.folder.list.get",
      ProjectThreadsGet: $"{@base}.project.threads.get",
      ProjectThreadCreate: $"{@base}.project.thread.create",
      ProjectThreadUpdate: $"{@base}.project.thread.update",
      ProjectThreadDelete: $"{@base}.project.thread.delete",
      ProjectThreadRollover: $"{@base}.project.thread.rollover",
      ProjectThreadNormalize: $"{@base}.project.thread.normalize",
      ProjectThreadUnlock: $"{@base}.project.thread.unlock",
      ProjectThreadStop: $"{@base}.project.thread.stop",
      ThreadTimelineGet: $"{@base}.thread.timeline.get",
      ThreadContinuityGet: $"{@base}.thread.continuity.get",
      ThreadIssuesGet: $"{@base}.thread.issues.get",
      ThreadIssueCreate: $"{@base}.thread.issue.create",
      ThreadIssueDetailGet: $"{@base}.thread.issue.detail.get",
      ThreadIssueDelete: $"{@base}.thread.issue.delete",
      ThreadIssueInterrupt: $"{@base}.thread.issue.interrupt",
      ThreadIssueMove: $"{@base}.thread.issue.move",
      ThreadIssueUpdate: $"{@base}.thread.issue.update",
      ThreadIssuesStart: $"{@base}.thread.issues.start",
      ThreadIssuesReorder: $"{@base}.thread.issues.reorder",
      PingStart: $"{@base}.command.ping",
      Events: $"octop.user.{uid}.bridge.{bid}.events"
    );
  }
}
