using OctOP.ProjectionWorker;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddHostedService<ProjectionWorkerService>();

var host = builder.Build();
host.Run();
