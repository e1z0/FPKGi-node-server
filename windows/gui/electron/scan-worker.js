const { parentPort, workerData } = require("worker_threads");
const { runProcessing } = require("../app/processor");

runProcessing(workerData.settings, {
    orbisCmdPath: workerData.orbisCmdPath,
    onLog: line => parentPort.postMessage({ type: "log", line })
})
    .then(summary => {
        parentPort.postMessage({ type: "done", summary });
    })
    .catch(error => {
        throw error;
    });
