using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Button = System.Windows.Controls.Button;
using Orientation = System.Windows.Controls.Orientation;
using TextBox = System.Windows.Controls.TextBox;
using WpfColor = System.Windows.Media.Color;
using WpfCursors = System.Windows.Input.Cursors;

sealed class LogWindow : Window
{
  private readonly Action _clearLogs;
  private readonly TextBlock _titleTextBlock;
  private readonly TextBlock _statusTextBlock;
  private readonly TextBlock _updatedAtTextBlock;
  private readonly TextBlock _errorTextBlock;
  private readonly TextBox _logTextBox;

  public bool AllowClose { get; set; }
  public bool Visible => IsVisible;

  public LogWindow(Action clearLogs)
  {
    _clearLogs = clearLogs;

    Title = "OctOP Local Agent";
    MinWidth = 720;
    MinHeight = 480;
    Width = 900;
    Height = 600;
    WindowStartupLocation = WindowStartupLocation.CenterScreen;
    Background = CreateBrush(0xF4, 0xF7, 0xFB);
    FontFamily = new System.Windows.Media.FontFamily("Segoe UI");
    FontSize = 13;

    Closing += OnClosing;

    var root = new Grid
    {
      Margin = new Thickness(20)
    };
    root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
    root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
    root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

    var headerCard = CreateCard();
    Grid.SetRow(headerCard, 0);
    var headerStack = new StackPanel();
    _titleTextBlock = new TextBlock
    {
      Text = "OctOP Local Agent",
      FontSize = 20,
      FontWeight = FontWeights.SemiBold,
      Foreground = CreateBrush(0x17, 0x17, 0x17)
    };
    _statusTextBlock = new TextBlock
    {
      Margin = new Thickness(0, 8, 0, 0)
    };
    _errorTextBlock = new TextBlock
    {
      Margin = new Thickness(0, 8, 0, 0),
      Foreground = CreateBrush(0xB9, 0x1C, 0x1C),
      Visibility = Visibility.Collapsed,
      TextWrapping = TextWrapping.Wrap
    };
    headerStack.Children.Add(_titleTextBlock);
    headerStack.Children.Add(_statusTextBlock);
    headerStack.Children.Add(_errorTextBlock);
    headerCard.Child = headerStack;

    var logCard = CreateCard();
    Grid.SetRow(logCard, 1);
    _logTextBox = new TextBox
    {
      IsReadOnly = true,
      AcceptsReturn = true,
      VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
      HorizontalScrollBarVisibility = ScrollBarVisibility.Auto,
      TextWrapping = TextWrapping.NoWrap,
      FontFamily = new System.Windows.Media.FontFamily("Consolas"),
      FontSize = 12,
      Background = CreateBrush(0x0F, 0x17, 0x2A),
      Foreground = CreateBrush(0xE5, 0xE7, 0xEB),
      BorderBrush = CreateBrush(0x0F, 0x17, 0x2A),
      BorderThickness = new Thickness(1),
      Padding = new Thickness(12)
    };
    logCard.Child = _logTextBox;

    var footerCard = CreateCard();
    Grid.SetRow(footerCard, 2);
    var footerGrid = new Grid();
    footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
    footerGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
    var clearButton = CreateSecondaryButton("로그 지우기");
    clearButton.Click += (_, _) => _clearLogs();
    _updatedAtTextBlock = new TextBlock
    {
      HorizontalAlignment = System.Windows.HorizontalAlignment.Right,
      VerticalAlignment = VerticalAlignment.Center,
      Foreground = CreateBrush(0x52, 0x52, 0x52)
    };
    Grid.SetColumn(_updatedAtTextBlock, 1);
    footerGrid.Children.Add(clearButton);
    footerGrid.Children.Add(_updatedAtTextBlock);
    footerCard.Child = footerGrid;

    root.Children.Add(headerCard);
    root.Children.Add(logCard);
    root.Children.Add(footerCard);
    Content = root;
  }

  public void BringToFront()
  {
    Activate();
    Topmost = true;
    Topmost = false;
    Focus();
  }

  public void UpdateState(
    string title,
    string status,
    System.Drawing.Color statusColor,
    IReadOnlyList<string> lines,
    DateTimeOffset? updatedAt,
    string? lastError)
  {
    _titleTextBlock.Text = title;
    _statusTextBlock.Text = status;
    _statusTextBlock.Foreground = ToBrush(statusColor);
    _errorTextBlock.Text = lastError ?? string.Empty;
    _errorTextBlock.Visibility = string.IsNullOrWhiteSpace(lastError) ? Visibility.Collapsed : Visibility.Visible;
    _logTextBox.Text = string.Join(Environment.NewLine, lines);
    _logTextBox.CaretIndex = _logTextBox.Text.Length;
    _logTextBox.ScrollToEnd();
    _updatedAtTextBlock.Text = updatedAt is DateTimeOffset value
      ? value.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss")
      : string.Empty;
  }

  private void OnClosing(object? sender, CancelEventArgs eventArgs)
  {
    if (AllowClose)
    {
      return;
    }

    eventArgs.Cancel = true;
    Hide();
  }

  private static Border CreateCard()
  {
    return new Border
    {
      Background = System.Windows.Media.Brushes.White,
      BorderBrush = CreateBrush(0xE5, 0xE7, 0xEB),
      BorderThickness = new Thickness(1),
      CornerRadius = new CornerRadius(20),
      Padding = new Thickness(20),
      Margin = new Thickness(0, 0, 0, 16)
    };
  }

  private static Button CreateSecondaryButton(string text)
  {
    return new Button
    {
      Content = text,
      Height = 34,
      Padding = new Thickness(14, 0, 14, 0),
      Background = System.Windows.Media.Brushes.White,
      BorderBrush = CreateBrush(0xD4, 0xD4, 0xD8),
      BorderThickness = new Thickness(1),
      Foreground = CreateBrush(0x17, 0x17, 0x17),
      Cursor = WpfCursors.Hand
    };
  }

  private static SolidColorBrush ToBrush(System.Drawing.Color color)
  {
    var brush = new SolidColorBrush(WpfColor.FromRgb(color.R, color.G, color.B));
    brush.Freeze();
    return brush;
  }

  private static SolidColorBrush CreateBrush(byte red, byte green, byte blue)
  {
    var brush = new SolidColorBrush(WpfColor.FromRgb(red, green, blue));
    brush.Freeze();
    return brush;
  }
}
