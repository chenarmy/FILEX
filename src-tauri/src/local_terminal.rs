use filex_contracts::{
    LocalShellOption, OpenLocalTerminalInput, OpenLocalTerminalResult, OperationResult,
    SessionSummary,
};
use filex_local_terminal::{LocalTerminalOutputEvent, LocalTerminalRuntime};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::TerminalEventPayload;
use crate::mcp_diagnostics::TerminalOutputRing;
use crate::terminal_logging::TerminalLogRuntime;

#[tauri::command]
pub(crate) fn list_local_shell_options(
    runtime: State<'_, LocalTerminalRuntime>,
) -> OperationResult<Vec<LocalShellOption>> {
    OperationResult::success(runtime.discover_shells())
}

#[tauri::command]
pub(crate) fn open_local_terminal(
    app: AppHandle,
    input: OpenLocalTerminalInput,
    runtime: State<'_, LocalTerminalRuntime>,
) -> OperationResult<OpenLocalTerminalResult> {
    match runtime.open_session(input) {
        Ok((session, shell, working_directory, rx)) => {
            spawn_local_terminal_output(app, session.id.clone(), rx);
            OperationResult::success(OpenLocalTerminalResult {
                session,
                shell,
                working_directory,
            })
        }
        Err(error) => OperationResult::failure(error),
    }
}

#[tauri::command]
pub(crate) async fn close_local_terminal(
    app: AppHandle,
    session_id: String,
    runtime: State<'_, LocalTerminalRuntime>,
    logs: State<'_, TerminalLogRuntime>,
) -> Result<OperationResult<SessionSummary>, ()> {
    let result = match runtime.close(&session_id) {
        Ok(summary) => OperationResult::success(summary),
        Err(error) => OperationResult::failure(error),
    };
    let _ = logs.stop(Some(&app), &session_id).await;
    Ok(result)
}

fn spawn_local_terminal_output(
    app: AppHandle,
    session_id: String,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<LocalTerminalOutputEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let payload = match event {
                LocalTerminalOutputEvent::Data(data) => TerminalEventPayload {
                    session_id: session_id.clone(),
                    kind: "data",
                    data: Some(data),
                    exit_status: None,
                },
                LocalTerminalOutputEvent::Exit(exit_status) => TerminalEventPayload {
                    session_id: session_id.clone(),
                    kind: "exit",
                    data: None,
                    exit_status: u32::try_from(exit_status).ok().or(Some(1)),
                },
                LocalTerminalOutputEvent::Closed => TerminalEventPayload {
                    session_id: session_id.clone(),
                    kind: "closed",
                    data: None,
                    exit_status: None,
                },
            };
            let closed = payload.kind != "data";
            let is_stream_closed = payload.kind == "closed";
            if let Some(data) = payload.data.as_deref() {
                app.state::<TerminalLogRuntime>()
                    .append(&app, &session_id, data);
                app.state::<TerminalOutputRing>().append(&session_id, data);
            }
            let _ = app.emit("terminal-output", payload);
            if closed {
                let _ = app.state::<LocalTerminalRuntime>().mark_exited(&session_id);
                let _ = app
                    .state::<TerminalLogRuntime>()
                    .stop(Some(&app), &session_id)
                    .await;
                if is_stream_closed {
                    app.state::<TerminalOutputRing>().remove(&session_id);
                    break;
                }
            }
        }
    });
}
