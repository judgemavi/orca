import { createContext, type ReactNode, useContext } from 'react';

type InteractionDetailContextValue = {
  activeLogId: string | null;
  onToggleLog: (id: string) => void;
};

const InteractionDetailContext =
  createContext<InteractionDetailContextValue | null>(null);

type InteractionDetailProviderProps = {
  children: ReactNode;
  value: InteractionDetailContextValue;
};

export function InteractionDetailProvider({
  children,
  value,
}: InteractionDetailProviderProps) {
  return (
    <InteractionDetailContext.Provider value={value}>
      {children}
    </InteractionDetailContext.Provider>
  );
}

export function useInteractionDetailContext() {
  return useContext(InteractionDetailContext);
}
