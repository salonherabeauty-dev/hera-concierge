import { createClient } from "@supabase/supabase-js";
import {
  parseShadowQualitySnapshot,
  type ShadowQualitySnapshot,
} from "./shadow.js";

export class SupabaseShadowQualityRepository {
  private readonly database;

  constructor(url: string, serviceRoleKey: string) {
    this.database = createClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
      global: { headers: { "X-Client-Info": "hera-shadow-quality/1.0" } },
    });
  }

  async snapshot(since: string): Promise<ShadowQualitySnapshot> {
    const { data, error } = await this.database.rpc("ai_shadow_quality_snapshot", {
      p_since: since,
    });
    if (error) throw new Error(`load shadow quality snapshot: ${error.message}`);
    return parseShadowQualitySnapshot(data);
  }
}
