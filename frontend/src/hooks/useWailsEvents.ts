import { useEffect } from 'react';
import { api } from '../lib/api';
import { errorMessage } from '../lib/format';
import type { BackendAPI, BackendEvent } from '../lib/types';
import { useTaskStore, type TaskStore } from '../store/tasks';

type Store = { getState(): TaskStore };

// Subscribe first, then atomically install the snapshot and replay every buffered event.
export function connectBackend(backend: BackendAPI, store: Store): () => void {
  let alive = true;
  let bootstrapping = true;
  let buffered: BackendEvent[] = [];
  let unsubscribe = () => {};
  store.getState().beginConnection();

  const fail = (error: unknown) => {
    if (!alive) return;
    alive = false;
    buffered = [];
    unsubscribe();
    store.getState().failConnection(errorMessage(error));
  };

  try {
    unsubscribe = backend.subscribe((event) => {
      if (!alive) return;
      if (bootstrapping) buffered.push(event);
      else store.getState().applyEvent(event);
    }, fail);
    // Handle a synchronous subscription error callback as well as a thrown error.
    if (!alive) { unsubscribe(); return () => {}; }
    void Promise.all([backend.listTasks(), backend.getSettings()]).then(([snapshot, settings]) => {
      if (!alive) return;
      const replay = buffered;
      buffered = [];
      bootstrapping = false;
      store.getState().loadSnapshot(snapshot, settings, replay);
    }).catch(fail);
  } catch (error) { fail(error); }

  return () => {
    alive = false;
    buffered = [];
    unsubscribe();
  };
}

export function useWailsEvents(attempt: number): void {
  useEffect(() => connectBackend(api, useTaskStore), [attempt]);
}
