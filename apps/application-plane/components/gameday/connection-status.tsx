'use client';

import StatusIndicator from '@cloudscape-design/components/status-indicator';

interface ConnectionStatusProps {
  isConnected: boolean;
}

export function ConnectionStatus({ isConnected }: ConnectionStatusProps) {
  return (
    <StatusIndicator type={isConnected ? 'success' : 'warning'}>
      {isConnected ? 'リアルタイム接続中' : 'ポーリングモード'}
    </StatusIndicator>
  );
}
