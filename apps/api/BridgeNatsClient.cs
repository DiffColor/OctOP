using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using NATS.Client;

namespace OctOP.Gateway;

public sealed class BridgeNatsClient : IDisposable
{
  private readonly string _natsUrl;
  private readonly int _requestTimeoutMs;
  private readonly object _syncRoot = new();
  private IConnection? _connection;

  public BridgeNatsClient(string natsUrl)
  {
    _natsUrl = natsUrl;
    _requestTimeoutMs = int.TryParse(Environment.GetEnvironmentVariable("OCTOP_NATS_REQUEST_TIMEOUT_MS"), out var parsedTimeout)
      ? Math.Max(parsedTimeout, 1000)
      : 30000;
  }

  public async Task<JsonNode?> RequestAsync(string subject, object payload, CancellationToken cancellationToken)
  {
    var data = JsonSerializer.SerializeToUtf8Bytes(payload);
    Msg response;

    try
    {
      response = await Task.Run(() => GetConnection().Request(subject, data, _requestTimeoutMs), cancellationToken);
    }
    catch (NATSNoRespondersException exception)
    {
      throw new BridgeNatsRequestException(
        "bridge_no_responders",
        $"No responders are available for the request. subject={subject}",
        subject,
        _requestTimeoutMs,
        exception);
    }
    catch (NATSTimeoutException exception)
    {
      throw new BridgeNatsRequestException(
        "bridge_timeout",
        $"Timeout occurred while waiting for bridge response. subject={subject}, timeout_ms={_requestTimeoutMs}",
        subject,
        _requestTimeoutMs,
        exception);
    }
    catch (NATSException exception)
    {
      throw new BridgeNatsRequestException(
        "bridge_transport_error",
        $"NATS transport error occurred while contacting bridge. subject={subject}",
        subject,
        _requestTimeoutMs,
        exception);
    }

    if (response?.Data is null || response.Data.Length == 0)
    {
      return null;
    }

    return JsonNode.Parse(response.Data);
  }

  public IAsyncSubscription Subscribe(string subject, EventHandler<MsgHandlerEventArgs> handler)
  {
    var subscription = GetConnection().SubscribeAsync(subject);
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
    lock (_syncRoot)
    {
      _connection?.Dispose();
      _connection = null;
    }
  }

  private IConnection GetConnection()
  {
    if (_connection is { State: ConnState.CONNECTED })
    {
      return _connection;
    }

    lock (_syncRoot)
    {
      if (_connection is { State: ConnState.CONNECTED })
      {
        return _connection;
      }

      _connection?.Dispose();
      var options = ConnectionFactory.GetDefaultOptions();
      options.Url = _natsUrl;
      _connection = new ConnectionFactory().CreateConnection(options);
      return _connection;
    }
  }
}

public sealed class BridgeNatsRequestException : Exception
{
  public BridgeNatsRequestException(string code, string message, string subject, int timeoutMs, Exception innerException)
    : base(message, innerException)
  {
    Code = code;
    Subject = subject;
    TimeoutMs = timeoutMs;
  }

  public string Code { get; }

  public string Subject { get; }

  public int TimeoutMs { get; }
}
