using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using Microsoft.Win32;

sealed class BrowserOption
{
  public required string DisplayName { get; init; }
  public required string ExecutablePath { get; init; }
  public string? RegistryKeyPath { get; init; }
  public Icon? Icon { get; init; }
}

static class BrowserSelection
{
  private static readonly (string DisplayName, string ExecutableName, string[] CandidatePaths)[] BrowserCandidates =
  [
    ("Google Chrome", "chrome.exe", [
      @"Google\Chrome\Application\chrome.exe",
      @"Google\Chrome Beta\Application\chrome.exe"
    ]),
    ("Microsoft Edge", "msedge.exe", [
      @"Microsoft\Edge\Application\msedge.exe",
      @"Microsoft\Edge Beta\Application\msedge.exe"
    ]),
    ("Mozilla Firefox", "firefox.exe", [
      @"Mozilla Firefox\firefox.exe"
    ]),
    ("Brave", "brave.exe", [
      @"BraveSoftware\Brave-Browser\Application\brave.exe"
    ]),
    ("Vivaldi", "vivaldi.exe", [
      @"Vivaldi\Application\vivaldi.exe"
    ])
  ];

  public static async Task<BrowserOption?> SelectBrowserAsync()
  {
    var browsers = await Task.Run(DiscoverBrowsers);
    return SelectBrowser(browsers);
  }

  public static BrowserOption? SelectBrowser(IReadOnlyList<BrowserOption> browsers)
  {
    if (browsers.Count == 0)
    {
      return null;
    }

    using var dialog = new Form
    {
      Text = "브라우저 선택",
      StartPosition = FormStartPosition.CenterScreen,
      FormBorderStyle = FormBorderStyle.FixedDialog,
      MinimizeBox = false,
      MaximizeBox = false,
      AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink,
      BackColor = Color.White
    };

    var root = new TableLayoutPanel
    {
      AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink,
      Padding = new Padding(18),
      ColumnCount = 1,
      RowCount = 3,
      Dock = DockStyle.Fill
    };

    root.Controls.Add(new Label
    {
      Text = "로그인에 사용할 브라우저를 선택해 주세요.",
      AutoSize = true,
      Font = new Font("Segoe UI", 10, FontStyle.Bold),
      ForeColor = Color.FromArgb(0x17, 0x17, 0x17),
      Margin = new Padding(0, 0, 0, 8)
    });

    root.Controls.Add(new Label
    {
      Text = "기본 브라우저 대신 다른 브라우저를 선택해 로그인할 수 있습니다.",
      AutoSize = true,
      Font = new Font("Segoe UI", 9),
      ForeColor = Color.FromArgb(0x52, 0x52, 0x52),
      Margin = new Padding(0, 0, 0, 12)
    });

    var browserPanel = new FlowLayoutPanel
    {
      AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink,
      WrapContents = true,
      FlowDirection = FlowDirection.LeftToRight,
      Margin = new Padding(0),
      Padding = new Padding(0, 4, 0, 0)
    };

    BrowserOption? selectedBrowser = null;

    foreach (var browser in browsers)
    {
      var tile = new FlowLayoutPanel
      {
        Width = 144,
        Height = 176,
        Margin = new Padding(0, 0, 20, 16),
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        BackColor = Color.Transparent
      };

      var button = new Button
      {
        Width = 104,
        Height = 104,
        Margin = new Padding(20, 0, 20, 10),
        BackColor = Color.Transparent,
        FlatStyle = FlatStyle.Flat,
        Padding = new Padding(0),
        Text = string.Empty
      };
      button.FlatAppearance.BorderSize = 0;
      button.FlatAppearance.MouseDownBackColor = Color.Transparent;
      button.FlatAppearance.MouseOverBackColor = Color.Transparent;

      if (browser.Icon is not null)
      {
        button.Image = new Bitmap(browser.Icon.ToBitmap(), new Size(96, 96));
        button.ImageAlign = ContentAlignment.MiddleCenter;
      }

      var label = new Label
      {
        Text = browser.DisplayName,
        Width = 144,
        Height = 52,
        TextAlign = ContentAlignment.TopCenter,
        Font = new Font("Segoe UI", 10, FontStyle.Regular),
        ForeColor = Color.FromArgb(0x17, 0x17, 0x17),
        BackColor = Color.Transparent
      };
      tile.Controls.Add(button);
      tile.Controls.Add(label);

      button.Click += (_, _) =>
      {
        selectedBrowser = browser;
        dialog.DialogResult = DialogResult.OK;
        dialog.Close();
      };

      foreach (Control control in new Control[] { tile, label })
      {
        control.Click += (_, _) =>
        {
          selectedBrowser = browser;
          dialog.DialogResult = DialogResult.OK;
          dialog.Close();
        };
      }

      browserPanel.Controls.Add(tile);
    }

    root.Controls.Add(browserPanel);
    dialog.Controls.Add(root);
    return dialog.ShowDialog() == DialogResult.OK ? selectedBrowser : null;
  }

  public static void Open(BrowserOption browser, string url)
  {
    using var process = new Process
    {
      StartInfo = new ProcessStartInfo
      {
        FileName = browser.ExecutablePath,
        UseShellExecute = true
      }
    };
    process.StartInfo.ArgumentList.Add(url);
    process.Start();
  }

  private static List<BrowserOption> DiscoverBrowsers()
  {
    var browsers = new List<BrowserOption>();
    var seenPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var seenNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    foreach (var browser in DiscoverRegisteredBrowsers())
    {
      if (string.IsNullOrWhiteSpace(browser.ExecutablePath) ||
          !File.Exists(browser.ExecutablePath) ||
          !seenPaths.Add(browser.ExecutablePath))
      {
        continue;
      }

      seenNames.Add(browser.DisplayName);
      browsers.Add(browser);
    }

    foreach (var candidate in BrowserCandidates)
    {
      var executablePath = ResolveBrowserExecutable(candidate.ExecutableName, candidate.CandidatePaths);
      if (string.IsNullOrWhiteSpace(executablePath) || !seenPaths.Add(executablePath))
      {
        continue;
      }

      browsers.Add(new BrowserOption
      {
        DisplayName = candidate.DisplayName,
        ExecutablePath = executablePath,
        RegistryKeyPath = null,
        Icon = TryExtractIcon(executablePath)
      });
    }

    return browsers
      .OrderBy(static browser => GetBrowserSortKey(browser.DisplayName))
      .ThenBy(static browser => browser.DisplayName, StringComparer.CurrentCultureIgnoreCase)
      .ToList();
  }

  private static IEnumerable<BrowserOption> DiscoverRegisteredBrowsers()
  {
    foreach (var (root, relativePath) in EnumerateBrowserRegistryRoots())
    {
      using var baseKey = root.OpenSubKey(relativePath);
      if (baseKey is null)
      {
        continue;
      }

      foreach (var subKeyName in baseKey.GetSubKeyNames())
      {
        using var browserKey = baseKey.OpenSubKey(subKeyName);
        if (browserKey is null)
        {
          continue;
        }

        var displayName = ResolveBrowserDisplayName(browserKey, subKeyName);
        var executablePath = ResolveRegisteredBrowserExecutable(browserKey);
        if (string.IsNullOrWhiteSpace(displayName) || string.IsNullOrWhiteSpace(executablePath) || !File.Exists(executablePath))
        {
          continue;
        }

        yield return new BrowserOption
        {
          DisplayName = displayName,
          ExecutablePath = executablePath,
          RegistryKeyPath = $@"{root.Name}\{relativePath}\{subKeyName}",
          Icon = ResolveRegisteredBrowserIcon(browserKey, executablePath)
        };
      }
    }
  }

  private static string? ResolveBrowserExecutable(string executableName, IEnumerable<string> candidatePaths)
  {
    foreach (var relativePath in candidatePaths)
    {
      foreach (var root in EnumerateInstallRoots())
      {
        var candidatePath = Path.Combine(root, relativePath);
        if (File.Exists(candidatePath))
        {
          return candidatePath;
        }
      }
    }

    return ResolveFromRegistry(executableName);
  }

  private static IEnumerable<string> EnumerateInstallRoots()
  {
    var roots = new[]
    {
      Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
      Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
      Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
    };

    return roots.Where(static path => !string.IsNullOrWhiteSpace(path)).Distinct(StringComparer.OrdinalIgnoreCase);
  }

  private static string? ResolveFromRegistry(string executableName)
  {
    foreach (var hive in new[] { Registry.CurrentUser, Registry.LocalMachine })
    {
      using var key = hive.OpenSubKey($@"Software\Microsoft\Windows\CurrentVersion\App Paths\{executableName}");
      var value = key?.GetValue(string.Empty) as string;
      if (!string.IsNullOrWhiteSpace(value) && File.Exists(value))
      {
        return value;
      }

      using var wowKey = hive.OpenSubKey($@"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\{executableName}");
      var wowValue = wowKey?.GetValue(string.Empty) as string;
      if (!string.IsNullOrWhiteSpace(wowValue) && File.Exists(wowValue))
      {
        return wowValue;
      }
    }

    return null;
  }

  private static Icon? TryExtractIcon(string executablePath)
  {
    try
    {
      return Icon.ExtractAssociatedIcon(executablePath);
    }
    catch
    {
      return null;
    }
  }

  private static IEnumerable<(RegistryKey Root, string RelativePath)> EnumerateBrowserRegistryRoots()
  {
    yield return (Registry.CurrentUser, @"Software\Clients\StartMenuInternet");
    yield return (Registry.LocalMachine, @"Software\Clients\StartMenuInternet");
    yield return (Registry.LocalMachine, @"Software\WOW6432Node\Clients\StartMenuInternet");
  }

  private static string ResolveBrowserDisplayName(RegistryKey browserKey, string fallbackName)
  {
    var directName = browserKey.GetValue(string.Empty) as string;
    if (!string.IsNullOrWhiteSpace(directName))
    {
      return directName.Trim();
    }

    using var capabilitiesKey = browserKey.OpenSubKey("Capabilities");
    var applicationName = capabilitiesKey?.GetValue("ApplicationName") as string;
    if (!string.IsNullOrWhiteSpace(applicationName))
    {
      return applicationName.Trim();
    }

    return fallbackName;
  }

  private static string? ResolveRegisteredBrowserExecutable(RegistryKey browserKey)
  {
    using var commandKey = browserKey.OpenSubKey(@"shell\open\command");
    var commandText = commandKey?.GetValue(string.Empty) as string;
    var executablePath = ExtractExecutablePath(commandText);
    if (!string.IsNullOrWhiteSpace(executablePath) && File.Exists(executablePath))
    {
      return executablePath;
    }

    using var capabilitiesKey = browserKey.OpenSubKey("Capabilities");
    var applicationIcon = capabilitiesKey?.GetValue("ApplicationIcon") as string;
    executablePath = ExtractExecutablePath(applicationIcon);
    if (!string.IsNullOrWhiteSpace(executablePath) && File.Exists(executablePath))
    {
      return executablePath;
    }

    return null;
  }

  private static Icon? ResolveRegisteredBrowserIcon(RegistryKey browserKey, string executablePath)
  {
    using var defaultIconKey = browserKey.OpenSubKey("DefaultIcon");
    var iconValue = defaultIconKey?.GetValue(string.Empty) as string;
    var iconPath = ExtractExecutablePath(iconValue);
    if (!string.IsNullOrWhiteSpace(iconPath) && File.Exists(iconPath))
    {
      var icon = TryExtractIcon(iconPath);
      if (icon is not null)
      {
        return icon;
      }
    }

    return TryExtractIcon(executablePath);
  }

  private static string? ExtractExecutablePath(string? commandText)
  {
    if (string.IsNullOrWhiteSpace(commandText))
    {
      return null;
    }

    var trimmed = commandText.Trim();
    if (trimmed.StartsWith('"'))
    {
      var closingQuoteIndex = trimmed.IndexOf('"', 1);
      if (closingQuoteIndex > 1)
      {
        return trimmed[1..closingQuoteIndex];
      }
    }

    var exeIndex = trimmed.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
    if (exeIndex >= 0)
    {
      return trimmed[..(exeIndex + 4)];
    }

    return null;
  }

  private static int GetBrowserSortKey(string displayName)
  {
    return displayName.ToLowerInvariant() switch
    {
      var value when value.Contains("chrome") => 0,
      var value when value.Contains("edge") => 1,
      var value when value.Contains("firefox") => 2,
      var value when value.Contains("brave") => 3,
      var value when value.Contains("vivaldi") => 4,
      _ => 10
    };
  }
}
