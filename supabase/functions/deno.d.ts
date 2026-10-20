// Just enough of the Deno global for the entrypoint to type-check under Node's tsc.
declare const Deno: {
  env: { toObject(): Record<string, string> };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};
