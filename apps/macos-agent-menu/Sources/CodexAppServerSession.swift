import Foundation

struct CodexAppServerAccountStatus: Sendable {
  let loggedIn: Bool
  let requiresOpenAIAuth: Bool
  let accountType: String?
  let summary: String
}

struct CodexAppServerLoginStartResult: Sendable {
  let loginId: String
  let authURL: URL
}

struct CodexAppServerLoginCompletedResult: Sendable {
  let loginId: String?
  let success: Bool
  let error: String?
}

struct CodexAppServerAccountUpdatedResult: Sendable {
  let authMode: String?
}

private enum CodexAppServerSessionError: LocalizedError {
  case terminated(String)
  case invalidResponse(String)

  var errorDescription: String? {
    switch self {
    case .terminated(let detail):
      return detail
    case .invalidResponse(let detail):
      return detail
    }
  }
}

private actor CodexAppServerSessionState {
  private var pendingRequests: [String: CheckedContinuation<Data?, Error>] = [:]
  private var loginWaiters: [String: CheckedContinuation<CodexAppServerLoginCompletedResult, Error>] = [:]
  private var bufferedLoginResults: [String: CodexAppServerLoginCompletedResult] = [:]
  private var accountUpdateWaiters: [UUID: (authMode: String?, continuation: CheckedContinuation<CodexAppServerAccountUpdatedResult, Error>)] = [:]
  private var bufferedAccountUpdates: [CodexAppServerAccountUpdatedResult] = []
  private var terminalError: Error?

  func registerRequest(id: String, continuation: CheckedContinuation<Data?, Error>) {
    if let terminalError {
      continuation.resume(throwing: terminalError)
      return
    }

    pendingRequests[id] = continuation
  }

  func resolveRequest(id: String, result: Data?) {
    guard let continuation = pendingRequests.removeValue(forKey: id) else {
      return
    }

    continuation.resume(returning: result)
  }

  func rejectRequest(id: String, error: Error) {
    guard let continuation = pendingRequests.removeValue(forKey: id) else {
      return
    }

    continuation.resume(throwing: error)
  }

  func registerLoginWaiter(
    loginId: String,
    continuation: CheckedContinuation<CodexAppServerLoginCompletedResult, Error>
  ) {
    if let terminalError {
      continuation.resume(throwing: terminalError)
      return
    }

    if let buffered = bufferedLoginResults.removeValue(forKey: loginId) {
      continuation.resume(returning: buffered)
      return
    }

    loginWaiters[loginId] = continuation
  }

  func cancelLoginWaiter(loginId: String, error: Error) {
    guard let continuation = loginWaiters.removeValue(forKey: loginId) else {
      return
    }

    continuation.resume(throwing: error)
  }

  func handleLoginCompleted(_ result: CodexAppServerLoginCompletedResult) {
    if let loginId = result.loginId, let waiter = loginWaiters.removeValue(forKey: loginId) {
      let completed = CodexAppServerLoginCompletedResult(
        loginId: result.loginId,
        success: result.success,
        error: result.error
      )
      waiter.resume(returning: completed)
      return
    }

    if let loginId = result.loginId {
      bufferedLoginResults[loginId] = result
      return
    }

    if let firstKey = loginWaiters.keys.first, let waiter = loginWaiters.removeValue(forKey: firstKey) {
      let completed = CodexAppServerLoginCompletedResult(
        loginId: result.loginId,
        success: result.success,
        error: result.error
      )
      waiter.resume(returning: completed)
    }
  }

  func registerAccountUpdateWaiter(
    authMode: String?,
    continuation: CheckedContinuation<CodexAppServerAccountUpdatedResult, Error>
  ) -> UUID {
    if let terminalError {
      continuation.resume(throwing: terminalError)
      return UUID()
    }

    if let bufferedIndex = bufferedAccountUpdates.firstIndex(where: {
      Self.normalizedAuthMode($0.authMode) == Self.normalizedAuthMode(authMode)
    }) {
      let buffered = bufferedAccountUpdates.remove(at: bufferedIndex)
      continuation.resume(returning: buffered)
      return UUID()
    }

    let waiterId = UUID()
    accountUpdateWaiters[waiterId] = (authMode: authMode, continuation: continuation)
    return waiterId
  }

  func cancelAccountUpdateWaiter(id: UUID, error: Error) {
    guard let waiter = accountUpdateWaiters.removeValue(forKey: id) else {
      return
    }

    waiter.continuation.resume(throwing: error)
  }

  func handleAccountUpdated(_ result: CodexAppServerAccountUpdatedResult) {
    if let matchingEntry = accountUpdateWaiters.first(where: {
      Self.normalizedAuthMode($0.value.authMode) == Self.normalizedAuthMode(result.authMode)
    }) {
      accountUpdateWaiters.removeValue(forKey: matchingEntry.key)
      matchingEntry.value.continuation.resume(returning: result)
      return
    }

    bufferedAccountUpdates.append(result)
  }

  func terminate(with error: Error) {
    if terminalError != nil {
      return
    }

    terminalError = error

    let pending = pendingRequests.values
    pendingRequests.removeAll()
    for continuation in pending {
      continuation.resume(throwing: error)
    }

    let waiters = loginWaiters.values
    loginWaiters.removeAll()
    for continuation in waiters {
      continuation.resume(throwing: error)
    }

    let accountWaiters = accountUpdateWaiters.values
    accountUpdateWaiters.removeAll()
    bufferedAccountUpdates.removeAll()
    for waiter in accountWaiters {
      waiter.continuation.resume(throwing: error)
    }
  }

  private static func normalizedAuthMode(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else {
      return nil
    }

    return trimmed
      .lowercased()
      .replacingOccurrences(of: "-", with: "")
      .replacingOccurrences(of: "_", with: "")
  }
}

private actor CodexAppServerLifecycleState {
  private var intentionalShutdown = false

  func markIntentionalShutdown() {
    intentionalShutdown = true
  }

  func isIntentionalShutdown() -> Bool {
    intentionalShutdown
  }
}

private actor CodexAppServerWaiterIDBox {
  private var value: UUID?

  func set(_ value: UUID) {
    self.value = value
  }

  func get() -> UUID? {
    value
  }
}

final class CodexAppServerSession: @unchecked Sendable {
  private let process: Process
  private let standardInput: FileHandle
  private let standardOutput: FileHandle
  private let standardError: FileHandle
  private let state = CodexAppServerSessionState()
  private let lifecycleState = CodexAppServerLifecycleState()
  private var stdoutTask: Task<Void, Never>?
  private var stderrTask: Task<Void, Never>?

  init(
    executableURL: URL,
    environment: [String: String],
    currentDirectoryURL: URL?,
    log: (@escaping @Sendable (String) -> Void)
  ) throws {
    let stdinPipe = Pipe()
    let stdoutPipe = Pipe()
    let stderrPipe = Pipe()

    process = Process()
    process.executableURL = executableURL
    process.arguments = ["app-server", "--listen", "stdio://"]
    process.environment = environment
    process.currentDirectoryURL = currentDirectoryURL
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe

    standardInput = stdinPipe.fileHandleForWriting
    standardOutput = stdoutPipe.fileHandleForReading
    standardError = stderrPipe.fileHandleForReading

    process.terminationHandler = { [weak self] process in
      guard let self else { return }
      Task {
        if await self.lifecycleState.isIntentionalShutdown() {
          await self.state.terminate(with: CodexAppServerSessionError.terminated("Codex app-server 세션이 종료되었습니다."))
          return
        }

        let message = "Codex app-server 종료됨 (status=\(process.terminationStatus))"
        await self.state.terminate(with: CodexAppServerSessionError.terminated(message))
      }
    }

    try process.run()

    stdoutTask = Task.detached { [weak self] in
      guard let self else { return }
      do {
        for try await line in self.standardOutput.bytes.lines {
          await self.handleStdoutLine(String(line))
        }
      } catch {
        await self.state.terminate(with: error)
      }
    }

    stderrTask = Task.detached {
      do {
        for try await line in self.standardError.bytes.lines {
          let trimmed = String(line).trimmingCharacters(in: .whitespacesAndNewlines)
          guard !trimmed.isEmpty else { continue }
          log(trimmed)
        }
      } catch {
      }
    }
  }

  deinit {
    stdoutTask?.cancel()
    stderrTask?.cancel()
    if process.isRunning {
      process.terminate()
    }
  }

  func initialize() async throws {
    _ = try await request(
      method: "initialize",
      params: [
        "clientInfo": [
          "name": "octop-agent-menu",
          "version": currentAgentMenuVersionTag()
        ],
        "capabilities": [
          "experimentalApi": true
        ]
      ]
    )
  }

  func readAccount(refreshToken: Bool = false) async throws -> CodexAppServerAccountStatus {
    let raw = try await request(
      method: "account/read",
      params: ["refreshToken": refreshToken]
    )

    guard let result = raw as? [String: Any] else {
      throw CodexAppServerSessionError.invalidResponse("account/read 응답 형식이 올바르지 않습니다.")
    }

    let requiresOpenAIAuth = result["requiresOpenaiAuth"] as? Bool ?? false
    guard let account = result["account"] as? [String: Any] else {
      return CodexAppServerAccountStatus(
        loggedIn: false,
        requiresOpenAIAuth: requiresOpenAIAuth,
        accountType: nil,
        summary: requiresOpenAIAuth ? "미로그인" : "계정 정보 없음"
      )
    }

    let email = account["email"] as? String
    let type = account["type"] as? String
    let summary: String
    if let email, !email.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      summary = email
    } else if type == "apiKey" {
      summary = "API Key 로그인됨"
    } else {
      summary = "로그인됨"
    }

    return CodexAppServerAccountStatus(
      loggedIn: true,
      requiresOpenAIAuth: requiresOpenAIAuth,
      accountType: type?.trimmingCharacters(in: .whitespacesAndNewlines),
      summary: summary
    )
  }

  func startChatGptLogin() async throws -> CodexAppServerLoginStartResult {
    let raw = try await request(
      method: "account/login/start",
      params: ["type": "chatgpt"]
    )

    guard let result = raw as? [String: Any],
          let type = result["type"] as? String,
          type == "chatgpt",
          let loginId = result["loginId"] as? String,
          let authURLText = result["authUrl"] as? String,
          let authURL = URL(string: authURLText) else {
      throw CodexAppServerSessionError.invalidResponse("app-server 로그인 URL을 확인하지 못했습니다.")
    }

    return CodexAppServerLoginStartResult(loginId: loginId, authURL: authURL)
  }

  func waitForLoginCompleted(loginId: String) async throws -> CodexAppServerLoginCompletedResult {
    let result = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        Task {
          await state.registerLoginWaiter(loginId: loginId, continuation: continuation)
        }
      }
    } onCancel: {
      Task {
        await self.state.cancelLoginWaiter(
          loginId: loginId,
          error: CancellationError()
        )
      }
    }

    guard result.success else {
      throw CodexAppServerSessionError.terminated(result.error ?? "Codex 로그인에 실패했습니다.")
    }

    return result
  }

  func waitForAccountUpdated(authMode: String?) async throws -> CodexAppServerAccountUpdatedResult {
    let waiterIDBox = CodexAppServerWaiterIDBox()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        Task {
          let registeredWaiterId = await state.registerAccountUpdateWaiter(
            authMode: authMode,
            continuation: continuation
          )
          await waiterIDBox.set(registeredWaiterId)
        }
      }
    } onCancel: {
      Task {
        guard let waiterId = await waiterIDBox.get() else {
          return
        }
        await self.state.cancelAccountUpdateWaiter(id: waiterId, error: CancellationError())
      }
    }
  }

  func logout() async throws {
    _ = try await request(method: "account/logout", params: nil)
  }

  func cancelLogin(loginId: String) async throws {
    _ = try await request(
      method: "account/login/cancel",
      params: ["loginId": loginId]
    )
  }

  func shutdown() async {
    stdoutTask?.cancel()
    stderrTask?.cancel()
    await lifecycleState.markIntentionalShutdown()
    await state.terminate(with: CodexAppServerSessionError.terminated("Codex app-server 세션이 종료되었습니다."))
    if process.isRunning {
      process.terminate()
    }
  }

  private func request(method: String, params: Any?) async throws -> Any? {
    let id = "req-\(UUID().uuidString.lowercased())"
    let requestData = try buildRequestData(id: id, method: method, params: params)

    let responseData: Data? = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        Task { [state, requestData] in
          await state.registerRequest(id: id, continuation: continuation)

          do {
            try standardInput.write(contentsOf: requestData)
          } catch {
            await state.rejectRequest(id: id, error: error)
          }
        }
      }
    } onCancel: {
      Task {
        await self.state.rejectRequest(id: id, error: CancellationError())
      }
    }

    guard let responseData else {
      return nil
    }

    return try JSONSerialization.jsonObject(with: responseData, options: [])
  }

  private func buildRequestData(id: String, method: String, params: Any?) throws -> Data {
    var payload: [String: Any] = [
      "jsonrpc": "2.0",
      "id": id,
      "method": method
    ]

    if let params {
      payload["params"] = params
    }

    var data = try JSONSerialization.data(withJSONObject: payload, options: [])
    data.append(0x0A)
    return data
  }

  private func handleStdoutLine(_ line: String) async {
    let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          let data = trimmed.data(using: .utf8),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      return
    }

    if let id = raw["id"] {
      if let error = raw["error"] as? [String: Any] {
        let message = (error["message"] as? String) ?? "Codex app-server 요청 실패"
        await state.rejectRequest(id: String(describing: id), error: CodexAppServerSessionError.terminated(message))
        return
      }

      let resultData: Data?
      if let result = raw["result"] {
        resultData = try? JSONSerialization.data(withJSONObject: result, options: [])
      } else {
        resultData = nil
      }

      await state.resolveRequest(id: String(describing: id), result: resultData)
      return
    }

    guard let method = raw["method"] as? String,
          let params = raw["params"] as? [String: Any] else {
      return
    }

    if method == "account/login/completed" {
      let completed = CodexAppServerLoginCompletedResult(
        loginId: params["loginId"] as? String,
        success: params["success"] as? Bool ?? false,
        error: params["error"] as? String
      )

      await state.handleLoginCompleted(completed)
      return
    }

    if method == "account/updated" {
      let updated = CodexAppServerAccountUpdatedResult(
        authMode: params["authMode"] as? String
      )
      await state.handleAccountUpdated(updated)
    }
  }
}
