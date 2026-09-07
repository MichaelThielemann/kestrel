import { defineContract } from "@michaelthielemann/kestrel/defineContract";
import type { KestrelError, Result } from "./errors.ts";

export interface Identity {
  id: string;
  claims: Record<string, unknown>;
}

declare global {
  namespace Kestrel {
    interface ContextExtensions {
      token?: string;
      identity?: Identity;
    }
  }
}

export interface Session {
  token: string;
  identity: Identity;
}

export type AuthnError = KestrelError<"TRANSIENT">;

export interface Authn {
  /** Wrong credentials are `Ok(null)`, never an `Err`. */
  login(credentials: Record<string, string>): Promise<Result<Session | null, AuthnError>>;
  resolve(token: string): Promise<Result<Identity | null, AuthnError>>;
  logout(token: string): Promise<Result<void, AuthnError>>;
}

export const AUTHN = defineContract<Authn>()("authn@1", ["login", "resolve", "logout"]);
