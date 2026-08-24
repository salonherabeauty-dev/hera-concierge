import { isCommandCentrePasswordlessPreview } from "./auth.js";
import { PreviewCommandCentreRepository } from "./previewRepository.js";
import { SupabaseCommandCentreRepository } from "./repository.js";

export function createCommandCentreReadRepository() {
  return isCommandCentrePasswordlessPreview()
    ? new PreviewCommandCentreRepository()
    : new SupabaseCommandCentreRepository();
}
