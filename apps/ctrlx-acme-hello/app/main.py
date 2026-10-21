import os, signal, sys, time
import ctrlxdatalayer
from ctrlxdatalayer.variant import Result

_stop = False
def _handler(signum, frame):
    global _stop
    _stop = True

def connection_string(ip="192.168.1.1", user="boschrexroth", password="boschrexroth", ssl_port=443):
    if "SNAP" in os.environ:          # inside the snap on ctrlX: local IPC, no credentials
        return "ipc://"
    cs = f"tcp://{user}:{password}@{ip}"  # dev machine -> remote ctrlX
    return cs if ssl_port == 443 else f"{cs}?sslport={ssl_port}"

def main():
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, _handler)
    with ctrlxdatalayer.system.System("") as system:
        system.start(False)
        client = system.factory().create_client(connection_string())
        if not client.is_connected():
            print("ERROR cannot connect to ctrlX Data Layer", flush=True)
            client.close()
            return 1
        with client:
            while not _stop and client.is_connected():
                result, var = client.read_sync("framework/metrics/system/cpu-utilisation-percent")
                if result == Result.OK:
                    print("CPU %:", var.get_float64(), flush=True)
                time.sleep(5.0)
        system.stop(False)
    return 0
