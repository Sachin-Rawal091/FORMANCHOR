import 'fake-indexeddb/auto';
import { setupChromeMocks } from './helpers/chromeMock';
import { disableActionSettleWait } from '../src/content/engines/ExecutionEngine';

setupChromeMocks();
disableActionSettleWait();
