// Registered via `node --import ./scripts/aurix-register.mjs` before proof scripts.
import { register } from 'node:module';

register('./aurix-hooks.mjs', import.meta.url);
