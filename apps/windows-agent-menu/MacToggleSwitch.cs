using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;
using WpfCursors = System.Windows.Input.Cursors;

sealed class MacToggleSwitch : ToggleButton
{
  private const double TrackWidth = 40;
  private const double TrackHeight = 24;
  private const double TrackRadius = 12;
  private const double ThumbSize = 20;
  private const double ThumbRadius = 10;
  private const double ThumbInset = 2;
  private const double ThumbCheckedLeft = 18;
  private const double ThumbTop = 2;

  public MacToggleSwitch()
  {
    Width = TrackWidth;
    Height = TrackHeight;
    Cursor = WpfCursors.Hand;
    VerticalAlignment = VerticalAlignment.Center;
    HorizontalAlignment = System.Windows.HorizontalAlignment.Right;
    FocusVisualStyle = null;
    Background = System.Windows.Media.Brushes.Transparent;
    BorderThickness = new Thickness(0);
    Padding = new Thickness(0);
    Margin = new Thickness(0, 0, 0, 0);
    Template = CreateTemplate();
  }

  private static ControlTemplate CreateTemplate()
  {
    var template = new ControlTemplate(typeof(MacToggleSwitch));

    var root = new FrameworkElementFactory(typeof(Canvas));
    root.SetValue(FrameworkElement.WidthProperty, TrackWidth);
    root.SetValue(FrameworkElement.HeightProperty, TrackHeight);
    root.SetValue(UIElement.SnapsToDevicePixelsProperty, true);
    root.SetValue(FrameworkElement.UseLayoutRoundingProperty, true);

    var track = new FrameworkElementFactory(typeof(Border));
    track.Name = "Track";
    track.SetValue(FrameworkElement.WidthProperty, TrackWidth);
    track.SetValue(FrameworkElement.HeightProperty, TrackHeight);
    track.SetValue(Border.CornerRadiusProperty, new CornerRadius(TrackRadius));
    track.SetValue(Border.BackgroundProperty, CreateBrush(0xE3, 0xE2, 0xE7));
    track.SetValue(Border.BorderThicknessProperty, new Thickness(0));
    track.SetValue(Canvas.LeftProperty, 0.0);
    track.SetValue(Canvas.TopProperty, 0.0);
    root.AppendChild(track);

    var thumb = new FrameworkElementFactory(typeof(Border));
    thumb.Name = "Thumb";
    thumb.SetValue(FrameworkElement.WidthProperty, ThumbSize);
    thumb.SetValue(FrameworkElement.HeightProperty, ThumbSize);
    thumb.SetValue(Border.CornerRadiusProperty, new CornerRadius(ThumbRadius));
    thumb.SetValue(Border.BackgroundProperty, CreateBrush(0xFF, 0xFF, 0xFF));
    thumb.SetValue(Border.BorderBrushProperty, CreateAlphaBrush(0xC1, 0xC6, 0xD7, 26));
    thumb.SetValue(Border.BorderThicknessProperty, new Thickness(1));
    thumb.SetValue(UIElement.EffectProperty, CreateThumbShadow());
    thumb.SetValue(Canvas.LeftProperty, ThumbInset);
    thumb.SetValue(Canvas.TopProperty, ThumbTop);
    root.AppendChild(thumb);

    template.VisualTree = root;

    var checkedTrigger = new Trigger
    {
      Property = IsCheckedProperty,
      Value = true
    };
    checkedTrigger.Setters.Add(new Setter(Border.BackgroundProperty, CreateBrush(0x00, 0x58, 0xBC), "Track"));
    checkedTrigger.Setters.Add(new Setter(Border.BorderThicknessProperty, new Thickness(0), "Track"));
    checkedTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, null, "Track"));
    checkedTrigger.Setters.Add(new Setter(Canvas.LeftProperty, ThumbCheckedLeft, "Thumb"));
    checkedTrigger.Setters.Add(new Setter(Canvas.TopProperty, ThumbTop, "Thumb"));
    checkedTrigger.Setters.Add(new Setter(Border.BorderThicknessProperty, new Thickness(0), "Thumb"));
    checkedTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, null, "Thumb"));

    var uncheckedTrigger = new Trigger
    {
      Property = IsCheckedProperty,
      Value = false
    };
    uncheckedTrigger.Setters.Add(new Setter(Border.BackgroundProperty, CreateBrush(0xE3, 0xE2, 0xE7), "Track"));
    uncheckedTrigger.Setters.Add(new Setter(Border.BorderThicknessProperty, new Thickness(0), "Track"));
    uncheckedTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, null, "Track"));
    uncheckedTrigger.Setters.Add(new Setter(Canvas.LeftProperty, ThumbInset, "Thumb"));
    uncheckedTrigger.Setters.Add(new Setter(Canvas.TopProperty, ThumbTop, "Thumb"));
    uncheckedTrigger.Setters.Add(new Setter(Border.BorderThicknessProperty, new Thickness(1), "Thumb"));
    uncheckedTrigger.Setters.Add(new Setter(Border.BorderBrushProperty, CreateAlphaBrush(0xC1, 0xC6, 0xD7, 26), "Thumb"));

    var mouseOverTrigger = new Trigger
    {
      Property = IsMouseOverProperty,
      Value = true
    };
    mouseOverTrigger.Setters.Add(new Setter(UIElement.OpacityProperty, 0.94));

    var pressedTrigger = new Trigger
    {
      Property = IsPressedProperty,
      Value = true
    };
    pressedTrigger.Setters.Add(new Setter(UIElement.OpacityProperty, 0.86));

    var disabledTrigger = new Trigger
    {
      Property = IsEnabledProperty,
      Value = false
    };
    disabledTrigger.Setters.Add(new Setter(UIElement.OpacityProperty, 0.48));

    template.Triggers.Add(checkedTrigger);
    template.Triggers.Add(uncheckedTrigger);
    template.Triggers.Add(mouseOverTrigger);
    template.Triggers.Add(pressedTrigger);
    template.Triggers.Add(disabledTrigger);
    return template;
  }

  private static SolidColorBrush CreateBrush(byte red, byte green, byte blue)
  {
    var brush = new SolidColorBrush(System.Windows.Media.Color.FromRgb(red, green, blue));
    brush.Freeze();
    return brush;
  }

  private static SolidColorBrush CreateAlphaBrush(byte red, byte green, byte blue, byte alpha)
  {
    var brush = new SolidColorBrush(System.Windows.Media.Color.FromArgb(alpha, red, green, blue));
    brush.Freeze();
    return brush;
  }

  private static System.Windows.Media.Effects.DropShadowEffect CreateThumbShadow()
  {
    return new System.Windows.Media.Effects.DropShadowEffect
    {
      BlurRadius = 2,
      ShadowDepth = 0.5,
      Opacity = 0.12,
      Color = System.Windows.Media.Color.FromRgb(0x1A, 0x1B, 0x1F)
    };
  }
}
