import { init } from './provider';

/**
 * Strapi loads an upload provider with `require(modulePath).init(options)`, so
 * the module's export must BE the object carrying `init` — not an ES default
 * binding sitting under `.default`. `export =` emits exactly that, which is
 * also why this file carries no other exports: TypeScript forbids mixing them.
 *
 * The public types live at `strapi-provider-upload-transcodely/types`.
 */
const provider = { init };

export = provider;
