using WinFormsApplication = System.Windows.Forms.Application;
using WpfApplication = System.Windows.Application;
using WpfShutdownMode = System.Windows.ShutdownMode;

internal static class Program
{
  private static Mutex? _singleInstanceMutex;

  [STAThread]
  private static void Main()
  {
    _singleInstanceMutex = new Mutex(initiallyOwned: true, name: @"Local\DiffColor.OctOP.WindowsAgentMenu", createdNew: out var createdNew);
    if (!createdNew)
    {
      _singleInstanceMutex.Dispose();
      _singleInstanceMutex = null;
      return;
    }

    _ = WpfApplication.Current ?? new WpfApplication
    {
      ShutdownMode = WpfShutdownMode.OnExplicitShutdown
    };

    try
    {
      WinFormsApplication.EnableVisualStyles();
      WinFormsApplication.SetCompatibleTextRenderingDefault(false);
      WinFormsApplication.Run(new AgentTrayApplicationContext());
    }
    finally
    {
      _singleInstanceMutex?.ReleaseMutex();
      _singleInstanceMutex?.Dispose();
      _singleInstanceMutex = null;
    }
  }
}
