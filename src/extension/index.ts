// The extension's wiring in the service worker. It hosts the layer and the Hub client; the agent, the model and the
// conversation live in DSH or in an MCP client, never here.
import './layer';
import './panel';
import { startExternalBridge } from './bridge';

// A build with WXT_BRIDGE set lets the Hub drive the user's real tab through this extension.
startExternalBridge();
