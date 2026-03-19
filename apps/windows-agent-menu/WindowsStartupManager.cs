using System.IO;
using Microsoft.Win32;

static class WindowsStartupManager
{
  private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
  private const string ValueName = "OctOPAgentMenu";

  public static bool IsEnabled(string executablePath)
  {
    using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
    var value = key?.GetValue(ValueName) as string;
    if (string.IsNullOrWhiteSpace(value))
    {
      return false;
    }

    return string.Equals(value.Trim(), Quote(executablePath), StringComparison.OrdinalIgnoreCase);
  }

  public static void SetEnabled(bool enabled, string executablePath)
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

  private static string Quote(string executablePath)
  {
    return $"\"{Path.GetFullPath(executablePath)}\"";
  }
}
