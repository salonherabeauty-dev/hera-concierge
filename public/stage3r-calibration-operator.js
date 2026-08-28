const tokenInput = document.querySelector("#access-token");
const runInput = document.querySelector("#run-id");
const output = document.querySelector("#output");
const configureButton = document.querySelector("#configure");
const stepButton = document.querySelector("#step");
const statusButton = document.querySelector("#status");

async function execute(action, details = {}) {
  const token = tokenInput.value.trim();
  if (token.length < 64) throw new Error("A valid one-time token is required.");
  const response = await fetch("/api/stage3r/worker", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...details }),
  });
  const result = await response.json();
  if (typeof result.runId === "string") runInput.value = result.runId;
  output.textContent = JSON.stringify({ httpStatus: response.status, ...result }, null, 2);
  const hasRun = runInput.value.length > 0;
  stepButton.disabled = !hasRun;
  statusButton.disabled = !hasRun;
  return result;
}

configureButton.addEventListener("click", async () => {
  configureButton.disabled = true;
  output.textContent = "Configuring without paid calls...";
  try {
    await execute("configure_calibration", {
      caseIndices: [0, 6, 10, 20, 1910],
      maxEstimatedCostUsd: 10,
    });
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : "Configuration failed.";
  } finally {
    configureButton.disabled = false;
  }
});

stepButton.addEventListener("click", async () => {
  stepButton.disabled = true;
  output.textContent = "Running one bounded case...";
  try {
    await execute("step", { runId: runInput.value });
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : "Step failed.";
  } finally {
    stepButton.disabled = false;
  }
});

statusButton.addEventListener("click", async () => {
  statusButton.disabled = true;
  output.textContent = "Checking status...";
  try {
    await execute("status", { runId: runInput.value });
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : "Status check failed.";
  } finally {
    statusButton.disabled = false;
  }
});
