import software.amazon.dynamodb.services.local.main.ServerRunner;
import org.eclipse.jetty.server.Server;
import org.eclipse.jetty.server.ServerConnector;

/** Test-only wrapper: the vendor CLI has no bind-address flag. Bind before starting. */
public class LoopbackDynamo {
  public static void main(String[] args) throws Exception {
    var proxy = ServerRunner.createServerFromCommandLineArgs(new String[] {
      "-inMemory", "-sharedDb", "-disableTelemetry", "-port", args[0]
    });
    var field = proxy.getClass().getDeclaredField("server");
    field.setAccessible(true);
    var server = (Server) field.get(proxy);
    for (var connector : server.getConnectors()) {
      if (!(connector instanceof ServerConnector network)) throw new IllegalStateException("Unknown connector");
      network.setHost("127.0.0.1");
      if (!"127.0.0.1".equals(network.getHost())) throw new IllegalStateException("Non-loopback connector");
    }
    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
      try { proxy.stop(); } catch (Exception error) { error.printStackTrace(); }
    }));
    proxy.start();
    System.out.println("Official DynamoDB Local is listening only on 127.0.0.1:" + args[0]);
    proxy.join();
  }
}
