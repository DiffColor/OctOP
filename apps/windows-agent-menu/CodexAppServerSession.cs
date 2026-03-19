using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

sealed class CodexAppServerSession : IAsyncDisposable
{
  private sealed class LoginCompletedResult
  {
    public string? LoginId { get; init; }
    public bool Success { get; init; }
    public string? Error { get; init; }
  }

  public sealed class AccountStatus
  {
    public bool LoggedIn { get; init; }
    public bool RequiresOpenAiAuth { get; init; }
    public string Summary { get; init; } = "확인 전";
  }

  public sealed class LoginStartResult
  {
    public string LoginId { get; init; } = string.Empty;
    public Uri AuthUri { get; init; } = new("https://auth.openai.com");
  }

  private readonly Process _process;
  private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> _pendingRequests =
    new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, TaskCompletionSource<LoginCompletedResult>> _loginWaiters =
    new(StringComparer.Ordinal);
  private readonly ConcurrentDictionary<string, LoginCompletedResult> _bufferedLoginResults =
    new(StringComparer.Ordinal);
  private readonly Action<string>? _log;
  private int _requestSequence;
  private int _terminated;

  private CodexAppServerSession(Process process, Action<string>? log)
  {
    _process = process;
    _log = log;
    _process.OutputDataReceived += HandleOutputDataReceived;
    _process.ErrorDataReceived += HandleErrorDataReceived;
    _process.Exited += HandleExited;
  }

  public static async Task<CodexAppServerSession> StartAsync(
    string codexCommandPath,
    string workingDirectory,
    IReadOnlyDictionary<string, string> environment,
    Action<string>? log,
    CancellationToken cancellationToken)
  {
    var startInfo = CreateStartInfo(codexCommandPath, workingDirectory, environment);
    var process = new Process
    {
      StartInfo = startInfo,
      EnableRaisingEvents = true
    };

    if (!process.Start())
    {
      throw new InvalidOperationException("Codex app-server 프로세스를 시작하지 못했습니다.");
    }

    var session = new CodexAppServerSession(process, log);
    process.BeginOutputReadLine();
    process.BeginErrorReadLine();
    await session.InitializeAsync(cancellationToken);
    return session;
  }

  public async Task<AccountStatus> ReadAccountAsync(CancellationToken cancellationToken, bool refreshToken = false)
  {
    var result = await RequestAsync(
      "account/read",
      new Dictionary<string, object?>
      {
        ["refreshToken"] = refreshToken
      },
      cancellationToken);

    var requiresOpenAiAuth =
      result.TryGetProperty("requiresOpenaiAuth", out var requiresProperty) &&
      requiresProperty.ValueKind == JsonValueKind.True;

    if (!result.TryGetProperty("account", out var accountProperty) || accountProperty.ValueKind == JsonValueKind.Null)
    {
      return new AccountStatus
      {
        LoggedIn = false,
        RequiresOpenAiAuth = requiresOpenAiAuth,
        Summary = requiresOpenAiAuth ? "미로그인" : "계정 정보 없음"
      };
    }

    var type = accountProperty.TryGetProperty("type", out var typeProperty)
      ? typeProperty.GetString()
      : null;
    var email = accountProperty.TryGetProperty("email", out var emailProperty)
      ? emailProperty.GetString()
      : null;

    var summary = !string.IsNullOrWhiteSpace(email)
      ? email!
      : string.Equals(type, "apiKey", StringComparison.OrdinalIgnoreCase)
        ? "API Key 로그인됨"
        : "로그인됨";

    return new AccountStatus
    {
      LoggedIn = true,
      RequiresOpenAiAuth = requiresOpenAiAuth,
      Summary = summary
    };
  }

  public async Task<LoginStartResult> StartChatGptLoginAsync(CancellationToken cancellationToken)
  {
    var result = await RequestAsync(
      "account/login/start",
      new Dictionary<string, object?>
      {
        ["type"] = "chatgpt"
      },
      cancellationToken);

    var type = result.TryGetProperty("type", out var typeProperty)
      ? typeProperty.GetString()
      : null;
    if (!string.Equals(type, "chatgpt", StringComparison.OrdinalIgnoreCase))
    {
      throw new InvalidOperationException($"지원하지 않는 로그인 응답입니다: {type ?? "unknown"}");
    }

    var loginId = result.TryGetProperty("loginId", out var loginIdProperty)
      ? loginIdProperty.GetString()
      : null;
    var authUrl = result.TryGetProperty("authUrl", out var authUrlProperty)
      ? authUrlProperty.GetString()
      : null;

    if (string.IsNullOrWhiteSpace(loginId) || string.IsNullOrWhiteSpace(authUrl) || !Uri.TryCreate(authUrl, UriKind.Absolute, out var authUri))
    {
      throw new InvalidOperationException("app-server 로그인 URL을 확인하지 못했습니다.");
    }

    return new LoginStartResult
    {
      LoginId = loginId,
      AuthUri = authUri
    };
  }

  public async Task WaitForLoginCompletedAsync(string loginId, CancellationToken cancellationToken)
  {
    if (_bufferedLoginResults.TryRemove(loginId, out var buffered))
    {
      EnsureLoginSucceeded(buffered);
      return;
    }

    var waiter = new TaskCompletionSource<LoginCompletedResult>(TaskCreationOptions.RunContinuationsAsynchronously);
    if (!_loginWaiters.TryAdd(loginId, waiter))
    {
      throw new InvalidOperationException("이미 진행 중인 로그인 완료 대기가 있습니다.");
    }

    using var registration = cancellationToken.Register(() =>
    {
      if (_loginWaiters.TryRemove(loginId, out var pending))
      {
        pending.TrySetCanceled(cancellationToken);
      }
    });

    var result = await waiter.Task;
    EnsureLoginSucceeded(result);
  }

  public async Task LogoutAsync(CancellationToken cancellationToken)
  {
    await RequestAsync("account/logout", null, cancellationToken);
  }

  public async Task CancelLoginAsync(string loginId, CancellationToken cancellationToken)
  {
    await RequestAsync(
      "account/login/cancel",
      new Dictionary<string, object?>
      {
        ["loginId"] = loginId
      },
      cancellationToken);
  }

  public async ValueTask DisposeAsync()
  {
    CompleteAll(new InvalidOperationException("Codex app-server 세션이 종료되었습니다."));

    if (!_process.HasExited)
    {
      try
      {
        _process.Kill(entireProcessTree: true);
      }
      catch
      {
      }
    }

    await _process.WaitForExitAsync();
    _process.Dispose();
  }

  private static ProcessStartInfo CreateStartInfo(
    string codexCommandPath,
    string workingDirectory,
    IReadOnlyDictionary<string, string> environment)
  {
    var invocation = new StringBuilder();
    invocation.Append(QuoteForCmd(codexCommandPath))
      .Append(' ')
      .Append(QuoteForCmd("app-server"))
      .Append(' ')
      .Append(QuoteForCmd("--listen"))
      .Append(' ')
      .Append(QuoteForCmd("stdio://"));

    var startInfo = new ProcessStartInfo
    {
      FileName = "cmd.exe",
      WorkingDirectory = workingDirectory,
      UseShellExecute = false,
      RedirectStandardInput = true,
      RedirectStandardOutput = true,
      RedirectStandardError = true,
      CreateNoWindow = true,
      StandardOutputEncoding = Encoding.UTF8,
      StandardErrorEncoding = Encoding.UTF8,
      Arguments = $"/d /s /c \"{invocation}\""
    };

    foreach (var entry in environment)
    {
      startInfo.Environment[entry.Key] = entry.Value;
    }

    return startInfo;
  }

  private static string QuoteForCmd(string value)
  {
    return $"\"{value.Replace("\"", "\"\"")}\"";
  }

  private async Task InitializeAsync(CancellationToken cancellationToken)
  {
    await RequestAsync(
      "initialize",
      new Dictionary<string, object?>
      {
        ["clientInfo"] = new Dictionary<string, object?>
        {
          ["name"] = "octop-agent-menu",
          ["version"] = AppMetadata.CurrentVersionTag
        },
        ["capabilities"] = new Dictionary<string, object?>
        {
          ["experimentalApi"] = true
        }
      },
      cancellationToken);
  }

  private async Task<JsonElement> RequestAsync(string method, object? @params, CancellationToken cancellationToken)
  {
    if (_process.HasExited)
    {
      throw new InvalidOperationException("Codex app-server 프로세스가 이미 종료되었습니다.");
    }

    var id = $"req-{Interlocked.Increment(ref _requestSequence)}";
    var waiter = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
    if (!_pendingRequests.TryAdd(id, waiter))
    {
      throw new InvalidOperationException($"중복 요청 ID가 생성되었습니다: {id}");
    }

    var payload = new Dictionary<string, object?>
    {
      ["jsonrpc"] = "2.0",
      ["id"] = id,
      ["method"] = method
    };

    if (@params is not null)
    {
      payload["params"] = @params;
    }

    var json = JsonSerializer.Serialize(payload);
    await _process.StandardInput.WriteLineAsync(json);
    await _process.StandardInput.FlushAsync();

    using var registration = cancellationToken.Register(() =>
    {
      if (_pendingRequests.TryRemove(id, out var pending))
      {
        pending.TrySetCanceled(cancellationToken);
      }
    });

    return await waiter.Task;
  }

  private void HandleOutputDataReceived(object sender, DataReceivedEventArgs eventArgs)
  {
    if (string.IsNullOrWhiteSpace(eventArgs.Data))
    {
      return;
    }

    try
    {
      using var document = JsonDocument.Parse(eventArgs.Data);
      var root = document.RootElement;
      if (root.TryGetProperty("id", out var idProperty))
      {
        var id = idProperty.ToString();
        if (id.Length == 0 || !_pendingRequests.TryRemove(id, out var pending))
        {
          return;
        }

        if (root.TryGetProperty("error", out var responseErrorProperty) && responseErrorProperty.ValueKind != JsonValueKind.Null)
        {
          var message = responseErrorProperty.TryGetProperty("message", out var messageProperty)
            ? messageProperty.GetString()
            : null;
          pending.TrySetException(new InvalidOperationException(message ?? "Codex app-server 요청 실패"));
          return;
        }

        var result = root.TryGetProperty("result", out var resultProperty)
          ? resultProperty.Clone()
          : default;
        pending.TrySetResult(result);
        return;
      }

      if (!root.TryGetProperty("method", out var methodProperty))
      {
        return;
      }

      var method = methodProperty.GetString();
      if (!string.Equals(method, "account/login/completed", StringComparison.Ordinal))
      {
        return;
      }

      var parameters = root.TryGetProperty("params", out var paramsProperty)
        ? paramsProperty
        : default;
      var completed = new LoginCompletedResult
      {
        LoginId = parameters.TryGetProperty("loginId", out var loginIdProperty)
          ? loginIdProperty.GetString()
          : null,
        Success = parameters.TryGetProperty("success", out var successProperty) &&
          successProperty.ValueKind == JsonValueKind.True,
        Error = parameters.TryGetProperty("error", out var errorProperty)
          ? errorProperty.GetString()
          : null
      };

      if (!string.IsNullOrWhiteSpace(completed.LoginId) &&
          _loginWaiters.TryRemove(completed.LoginId, out var waiter))
      {
        waiter.TrySetResult(completed);
        return;
      }

      if (!string.IsNullOrWhiteSpace(completed.LoginId))
      {
        _bufferedLoginResults[completed.LoginId] = completed;
      }
    }
    catch (Exception error)
    {
      _log?.Invoke($"app-server stdout 파싱 실패: {error.Message}");
    }
  }

  private void HandleErrorDataReceived(object sender, DataReceivedEventArgs eventArgs)
  {
    if (string.IsNullOrWhiteSpace(eventArgs.Data))
    {
      return;
    }

    _log?.Invoke(eventArgs.Data);
  }

  private void HandleExited(object? sender, EventArgs eventArgs)
  {
    CompleteAll(new InvalidOperationException($"Codex app-server 종료됨 (exit={_process.ExitCode})"));
  }

  private void CompleteAll(Exception error)
  {
    if (Interlocked.Exchange(ref _terminated, 1) != 0)
    {
      return;
    }

    foreach (var entry in _pendingRequests)
    {
      if (_pendingRequests.TryRemove(entry.Key, out var pending))
      {
        pending.TrySetException(error);
      }
    }

    foreach (var entry in _loginWaiters)
    {
      if (_loginWaiters.TryRemove(entry.Key, out var waiter))
      {
        waiter.TrySetException(error);
      }
    }
  }

  private static void EnsureLoginSucceeded(LoginCompletedResult result)
  {
    if (result.Success)
    {
      return;
    }

    throw new InvalidOperationException(result.Error ?? "Codex 로그인에 실패했습니다.");
  }
}
