using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Microsoft.Win32;

static class WindowsStartupManager
{
  private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
  private const string ValueName = "OctOPAgentMenu";
  private const string ShortcutFileName = "OctOPAgentMenu.lnk";

  public static bool IsEnabled(string executablePath)
  {
    var normalizedExecutablePath = Normalize(executablePath);
    return IsRegistryEnabled(normalizedExecutablePath) || IsStartupShortcutEnabled(normalizedExecutablePath);
  }

  public static void SetEnabled(bool enabled, string executablePath)
  {
    var normalizedExecutablePath = Normalize(executablePath);
    Exception? registryError = null;
    Exception? shortcutError = null;

    try
    {
      SetRegistryEnabled(enabled, normalizedExecutablePath);
    }
    catch (Exception error)
    {
      registryError = error;
    }

    try
    {
      SetStartupShortcutEnabled(enabled, normalizedExecutablePath);
    }
    catch (Exception error)
    {
      shortcutError = error;
    }

    if (IsEnabled(normalizedExecutablePath) == enabled)
    {
      return;
    }

    if (registryError is not null && shortcutError is not null)
    {
      throw new AggregateException(
        $"Windows 자동 시작 {(enabled ? "등록" : "해제")}에 실패했습니다.",
        registryError,
        shortcutError);
    }

    throw registryError
      ?? shortcutError
      ?? new InvalidOperationException($"Windows 자동 시작 {(enabled ? "등록" : "해제")} 상태를 확인하지 못했습니다.");
  }

  private static bool IsRegistryEnabled(string executablePath)
  {
    using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
    var value = key?.GetValue(ValueName) as string;
    if (string.IsNullOrWhiteSpace(value))
    {
      return false;
    }

    return string.Equals(value.Trim(), Quote(executablePath), StringComparison.OrdinalIgnoreCase);
  }

  private static void SetRegistryEnabled(bool enabled, string executablePath)
  {
    using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath);
    if (enabled)
    {
      key.SetValue(ValueName, Quote(executablePath), RegistryValueKind.String);
      return;
    }

    if (key.GetValue(ValueName) is not null)
    {
      key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
  }

  private static bool IsStartupShortcutEnabled(string executablePath)
  {
    var shortcutPath = GetStartupShortcutPath();
    if (!File.Exists(shortcutPath))
    {
      return false;
    }

    try
    {
      var targetPath = ReadShortcutTargetPath(shortcutPath);
      return string.Equals(Normalize(targetPath), executablePath, StringComparison.OrdinalIgnoreCase);
    }
    catch
    {
      return false;
    }
  }

  private static void SetStartupShortcutEnabled(bool enabled, string executablePath)
  {
    var shortcutPath = GetStartupShortcutPath();
    var startupDirectory = Path.GetDirectoryName(shortcutPath);
    if (string.IsNullOrWhiteSpace(startupDirectory))
    {
      throw new InvalidOperationException("Startup 폴더 경로를 확인하지 못했습니다.");
    }

    Directory.CreateDirectory(startupDirectory);

    if (!enabled)
    {
      if (File.Exists(shortcutPath))
      {
        File.Delete(shortcutPath);
      }

      return;
    }

    CreateShortcut(shortcutPath, executablePath);
  }

  private static string GetStartupShortcutPath()
  {
    var startupDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
    if (string.IsNullOrWhiteSpace(startupDirectory))
    {
      throw new InvalidOperationException("Windows Startup 폴더를 찾지 못했습니다.");
    }

    return Path.Combine(startupDirectory, ShortcutFileName);
  }

  private static string ReadShortcutTargetPath(string shortcutPath)
  {
    object? shell = null;
    object? shortcut = null;

    try
    {
      var shellType = Type.GetTypeFromProgID("WScript.Shell")
        ?? throw new InvalidOperationException("WScript.Shell COM 타입을 찾지 못했습니다.");
      shell = Activator.CreateInstance(shellType)
        ?? throw new InvalidOperationException("WScript.Shell COM 객체를 만들지 못했습니다.");
      shortcut = shellType.InvokeMember(
        "CreateShortcut",
        BindingFlags.InvokeMethod,
        binder: null,
        target: shell,
        args: [shortcutPath]);

      var rawTargetPath = shortcut?.GetType().InvokeMember(
        "TargetPath",
        BindingFlags.GetProperty,
        binder: null,
        target: shortcut,
        args: null) as string;

      return rawTargetPath ?? string.Empty;
    }
    finally
    {
      ReleaseComObject(shortcut);
      ReleaseComObject(shell);
    }
  }

  private static void CreateShortcut(string shortcutPath, string executablePath)
  {
    object? shell = null;
    object? shortcut = null;

    try
    {
      var shellType = Type.GetTypeFromProgID("WScript.Shell")
        ?? throw new InvalidOperationException("WScript.Shell COM 타입을 찾지 못했습니다.");
      shell = Activator.CreateInstance(shellType)
        ?? throw new InvalidOperationException("WScript.Shell COM 객체를 만들지 못했습니다.");
      shortcut = shellType.InvokeMember(
        "CreateShortcut",
        BindingFlags.InvokeMethod,
        binder: null,
        target: shell,
        args: [shortcutPath]);

      var shortcutType = shortcut?.GetType()
        ?? throw new InvalidOperationException("Startup 바로가기 객체를 만들지 못했습니다.");
      var workingDirectory = Path.GetDirectoryName(executablePath) ?? Environment.CurrentDirectory;

      shortcutType.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, [executablePath]);
      shortcutType.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, [workingDirectory]);
      shortcutType.InvokeMember("IconLocation", BindingFlags.SetProperty, null, shortcut, [executablePath]);
      shortcutType.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, Array.Empty<object>());
    }
    finally
    {
      ReleaseComObject(shortcut);
      ReleaseComObject(shell);
    }
  }

  private static void ReleaseComObject(object? value)
  {
    if (value is not null && Marshal.IsComObject(value))
    {
      Marshal.FinalReleaseComObject(value);
    }
  }

  private static string Quote(string executablePath)
  {
    return $"\"{Normalize(executablePath)}\"";
  }

  private static string Normalize(string executablePath)
  {
    return Path.GetFullPath(executablePath);
  }
}
