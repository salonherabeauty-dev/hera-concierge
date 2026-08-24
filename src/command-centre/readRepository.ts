import { SupabaseCommandCentreRepository } from "./repository.js";

export function createCommandCentreReadRepository() {
  return new SupabaseCommandCentreRepository();
}
