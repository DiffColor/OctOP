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

  public static BrowserOption? SelectBrowser()
  {
    var browsers = DiscoverBrowsers();
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
      Margin = new Padding(0)
    };

    BrowserOption? selectedBrowser = null;

    foreach (var browser in browsers)
    {
      var tile = new FlowLayoutPanel
      {
        Width = 116,
        Height = 120,
        Margin = new Padding(0, 0, 12, 12),
        FlowDirection = FlowDirection.TopDown,
        WrapContents = false,
        BackColor = Color.Transparent
      };

      var button = new Button
      {
        Width = 64,
        Height = 64,
        Margin = new Padding(26, 0, 26, 8),
        BackColor = Color.White,
        FlatStyle = FlatStyle.Flat,
        Padding = new Padding(0),
        Text = string.Empty
      };
      button.FlatAppearance.BorderColor = Color.FromArgb(0xE5, 0xE7, 0xEB);
      button.FlatAppearance.BorderSize = 1;
      button.FlatAppearance.MouseDownBackColor = Color.FromArgb(0xF3, 0xF4, 0xF6);
      button.FlatAppearance.MouseOverBackColor = Color.FromArgb(0xF9, 0xFA, 0xFB);

      if (browser.Icon is not null)
      {
        button.Image = new Bitmap(browser.Icon.ToBitmap(), new Size(40, 40));
        button.ImageAlign = ContentAlignment.MiddleCenter;
      }

      var label = new Label
      {
        Text = browser.DisplayName,
        Width = 116,
        Height = 36,
        TextAlign = ContentAlignment.TopCenter,
        Font = new Font("Segoe UI", 9, FontStyle.Regular),
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
        Icon = TryExtractIcon(executablePath)
      });
    }

    return browsers;
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
}
