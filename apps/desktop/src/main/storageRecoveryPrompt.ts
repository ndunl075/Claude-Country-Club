import { dialog } from 'electron';

export async function confirmStorageRecovery(): Promise<boolean> {
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'Country Club storage recovery',
    message: 'Your damaged saved rounds and preferences cannot be read.',
    detail: 'Choose “Preserve files and start fresh” to keep the original database and its SQLite sidecar files in a local recovery folder before starting with fresh rounds and preferences. Existing agent connections and authentication are not changed. Choose “Quit and keep files” to exit without changing these files.',
    buttons: ['Quit and keep files', 'Preserve files and start fresh'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return response === 1;
}
