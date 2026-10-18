'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, Typography, TextField, Button, Box, IconButton, InputAdornment, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import { Visibility, VisibilityOff, Save, Download, Upload } from '@mui/icons-material';
import { encryptConfig, decryptConfig } from '@/lib/security/encryption';
import { secureStore, secureLoad } from '@/lib/security/storage';
import { toast } from 'sonner';

export default function ApiKeysSettings() {
  const [keys, setKeys] = useState({ algolia: '', customRpc: '' });
  const [showKeys, setShowKeys] = useState(false);
  
  const [exportPassphrase, setExportPassphrase] = useState('');
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  
  const [importPassphrase, setImportPassphrase] = useState('');
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFileContent, setImportFileContent] = useState<string>('');

  useEffect(() => {
    loadKeys();
  }, []);

  const loadKeys = async () => {
    const algolia = await secureLoad('algoliaKey');
    const customRpc = await secureLoad('customRpc');
    setKeys({
      algolia: algolia || '',
      customRpc: customRpc || ''
    });
  };

  const handleSave = async () => {
    await secureStore('algoliaKey', keys.algolia);
    await secureStore('customRpc', keys.customRpc);
    toast.success('API Keys saved securely');
  };

  const handleExport = async () => {
    if (!exportPassphrase) {
      toast.error('Passphrase is required for export');
      return;
    }
    
    try {
      const config = JSON.stringify(keys);
      const encrypted = await encryptConfig(config, exportPassphrase);
      
      const blob = new Blob([encrypted], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'trellis-config-backup.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setExportDialogOpen(false);
      setExportPassphrase('');
      toast.success('Configuration exported successfully');
    } catch (error) {
      toast.error('Export failed');
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        if (event.target?.result) {
          setImportFileContent(event.target.result as string);
          setImportDialogOpen(true);
        }
      };
      reader.readAsText(file);
    }
  };

  const handleImport = async () => {
    if (!importPassphrase) {
      toast.error('Passphrase is required for import');
      return;
    }
    
    try {
      const decrypted = await decryptConfig(importFileContent, importPassphrase);
      const importedKeys = JSON.parse(decrypted);
      
      setKeys(importedKeys);
      await secureStore('algoliaKey', importedKeys.algolia || '');
      await secureStore('customRpc', importedKeys.customRpc || '');
      
      setImportDialogOpen(false);
      setImportPassphrase('');
      setImportFileContent('');
      toast.success('Configuration imported successfully');
    } catch (error) {
      toast.error('Import failed. Invalid passphrase or corrupted file.');
    }
  };

  return (
    <div className="pt-24 pb-12 min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
        <Typography variant="h4" className="mb-6 glow-text font-bold">API Key Management</Typography>
        
        <Card className="bg-trellis-deep/50 border border-trellis-vine/20 mb-6 backdrop-blur-md">
          <CardContent className="space-y-6">
            <Typography variant="h6" className="text-white">Local Configuration</Typography>
            
            <TextField
              fullWidth
              label="Algolia API Key"
              type={showKeys ? 'text' : 'password'}
              value={keys.algolia}
              onChange={(e) => setKeys({ ...keys, algolia: e.target.value })}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowKeys(!showKeys)} edge="end" className="text-gray-400">
                      {showKeys ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
                className: "text-white"
              }}
              InputLabelProps={{ className: "text-gray-400" }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: 'rgba(79, 191, 155, 0.3)' } } }}
            />

            <TextField
              fullWidth
              label="Custom RPC Endpoint"
              type={showKeys ? 'text' : 'password'}
              value={keys.customRpc}
              onChange={(e) => setKeys({ ...keys, customRpc: e.target.value })}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowKeys(!showKeys)} edge="end" className="text-gray-400">
                      {showKeys ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
                className: "text-white"
              }}
              InputLabelProps={{ className: "text-gray-400" }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: 'rgba(79, 191, 155, 0.3)' } } }}
            />

            <Box className="flex gap-4 pt-4">
              <Button 
                variant="contained" 
                startIcon={<Save />}
                onClick={handleSave}
                className="bg-trellis-vine hover:bg-trellis-leaf text-white"
              >
                Save Securely
              </Button>
            </Box>
          </CardContent>
        </Card>

        <Card className="bg-trellis-deep/50 border border-trellis-vine/20 backdrop-blur-md">
          <CardContent>
            <Typography variant="h6" className="text-white mb-4">Backup & Restore</Typography>
            <Typography variant="body2" className="text-gray-400 mb-6">
              Export your configuration to a securely encrypted file, or restore from an existing backup.
            </Typography>
            
            <Box className="flex gap-4">
              <Button 
                variant="outlined" 
                startIcon={<Download />}
                onClick={() => setExportDialogOpen(true)}
                className="border-trellis-vine text-trellis-vine hover:bg-trellis-vine/10"
              >
                Export Backup
              </Button>
              
              <Button 
                variant="outlined" 
                component="label"
                startIcon={<Upload />}
                className="border-trellis-vine text-trellis-vine hover:bg-trellis-vine/10"
              >
                Import Backup
                <input type="file" hidden accept=".json" onChange={handleFileChange} />
              </Button>
            </Box>
          </CardContent>
        </Card>

        {/* Export Dialog */}
        <Dialog open={exportDialogOpen} onClose={() => setExportDialogOpen(false)} PaperProps={{ className: "bg-trellis-deep border border-trellis-vine/20 text-white" }}>
          <DialogTitle>Export Encrypted Backup</DialogTitle>
          <DialogContent>
            <Typography variant="body2" className="mb-4 text-gray-300 mt-2">
              Enter a passphrase to encrypt your backup. You will need this passphrase to restore the file.
            </Typography>
            <TextField
              fullWidth
              autoFocus
              label="Passphrase"
              type="password"
              value={exportPassphrase}
              onChange={(e) => setExportPassphrase(e.target.value)}
              InputProps={{ className: "text-white" }}
              InputLabelProps={{ className: "text-gray-400" }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: 'rgba(79, 191, 155, 0.3)' } } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setExportDialogOpen(false)} className="text-gray-400">Cancel</Button>
            <Button onClick={handleExport} className="text-trellis-vine">Export</Button>
          </DialogActions>
        </Dialog>

        {/* Import Dialog */}
        <Dialog open={importDialogOpen} onClose={() => { setImportDialogOpen(false); setImportFileContent(''); }} PaperProps={{ className: "bg-trellis-deep border border-trellis-vine/20 text-white" }}>
          <DialogTitle>Import Backup</DialogTitle>
          <DialogContent>
            <Typography variant="body2" className="mb-4 text-gray-300 mt-2">
              Enter the passphrase used to encrypt this backup file.
            </Typography>
            <TextField
              fullWidth
              autoFocus
              label="Passphrase"
              type="password"
              value={importPassphrase}
              onChange={(e) => setImportPassphrase(e.target.value)}
              InputProps={{ className: "text-white" }}
              InputLabelProps={{ className: "text-gray-400" }}
              sx={{ '& .MuiOutlinedInput-root': { '& fieldset': { borderColor: 'rgba(79, 191, 155, 0.3)' } } }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => { setImportDialogOpen(false); setImportFileContent(''); }} className="text-gray-400">Cancel</Button>
            <Button onClick={handleImport} className="text-trellis-vine">Import</Button>
          </DialogActions>
        </Dialog>
      </div>
    </div>
  );
}
