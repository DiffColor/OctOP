using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using NATS.Client;

namespace OctOP.Gateway;

public sealed class BridgeNatsClient : IDisposable
{
  private readonly IConnection _connection;

  public BridgeNatsClient(string natsUrl)
  {
    var options = ConnectionFactory.GetDefaultOptions();
    options.Url = natsUrl;
    _connection = new ConnectionFactory().CreateConnection(options);
  }

  public async Task<JsonNode?> RequestAsync(string subject, object payload, CancellationToken cancellationToken)
  {
    var data = JsonSerializer.SerializeToUtf8Bytes(payload);
    var response = await Task.Run(() => _connection.Request(subject, data, 10000), cancellationToken);

    if (response?.Data is null || response.Data.Length == 0)
    {
      return null;
    }

    return JsonNode.Parse(response.Data);
  }

  public IAsyncSubscription Subscribe(string subject, EventHandler<MsgHandlerEventArgs> handler)
  {
    var subscription = _connection.SubscribeAsync(subject);
    subscription.MessageHandler += handler;
    subscription.Start();
    return subscription;
  }

  public static string Decode(Msg message)
  {
    return message.Data is { Length: > 0 } ? Encoding.UTF8.GetString(message.Data) : "{}";
  }

  public void Dispose()
  {
    _connection.Dispose();
  }
}
