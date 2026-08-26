import FileExplorer from '../../components/fileExplorer/FileExplorer';

export default function BrokerDocuments() {
  return (
    <div className="-m-4 lg:-m-6 h-[calc(100vh-4rem)]">
      <FileExplorer role="broker" />
    </div>
  );
}
