using WinFormsApplication = System.Windows.Forms.Application;
using WpfApplication = System.Windows.Application;
using WpfShutdownMode = System.Windows.ShutdownMode;

internal static class Program
{
  [STAThread]
  private static void Main()
  {
    _ = WpfApplication.Current ?? new WpfApplication
    {
      ShutdownMode = WpfShutdownMode.OnExplicitShutdown
    };

    WinFormsApplication.EnableVisualStyles();
    WinFormsApplication.SetCompatibleTextRenderingDefault(false);
    WinFormsApplication.Run(new AgentTrayApplicationContext());
  }
}
