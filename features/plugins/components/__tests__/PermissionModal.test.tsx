import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { PermissionModal } from '../PermissionModal';
import '@testing-library/jest-dom';

describe('PermissionModal', () => {
  const mockManifest = {
    id: 'plg_123',
    name: 'High Privilege Plugin',
    version: '2.0.0',
    permissions: ['network:read', 'wallet:sign']
  };

  it('renders permission requests correctly', () => {
    render(<PermissionModal manifest={mockManifest} onApprove={() => {}} onDeny={() => {}} />);
    expect(screen.getByText(/High Privilege Plugin/i)).toBeInTheDocument();
    expect(screen.getByText('network:read')).toBeInTheDocument();
    expect(screen.getByText('wallet:sign')).toBeInTheDocument();
  });

  it('calls onDeny when deny button is clicked', () => {
    const onDenyMock = jest.fn();
    render(<PermissionModal manifest={mockManifest} onApprove={() => {}} onDeny={onDenyMock} />);
    
    const denyBtn = screen.getByTestId('deny-permission-btn');
    fireEvent.click(denyBtn);
    expect(onDenyMock).toHaveBeenCalledTimes(1);
  });

  it('calls onApprove when approve button is clicked', () => {
    const onApproveMock = jest.fn();
    render(<PermissionModal manifest={mockManifest} onApprove={onApproveMock} onDeny={() => {}} />);
    
    const approveBtn = screen.getByTestId('approve-permission-btn');
    fireEvent.click(approveBtn);
    expect(onApproveMock).toHaveBeenCalledTimes(1);
  });
});
