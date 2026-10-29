// The first import of every eval that calls a model. See environment.mjs for why.
import './environment.mjs';
import {flush} from '../../server/tracing.mjs';

// Spans leave in batches, and most evals end with process.exit, which would
// drop the last batch and with it the end of the run's cost.
const exit = process.exit.bind(process);
process.exit = code => { flush().finally(() => exit(code)); };
process.once('beforeExit', () => flush());
