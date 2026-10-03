import { Broker, type BrokerOptions } from "./broker.ts";

// Started detached by BrowserClient; its configuration is one JSON argument.
const broker = new Broker(JSON.parse(process.argv[2] ?? "") as BrokerOptions);
broker.start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
