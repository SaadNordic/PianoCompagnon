package app.pianocompagnon;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Lit les pianos et claviers MIDI branchés en USB (API android.media.midi)
 * et transmet les octets reçus à l'application web (événement "message").
 */
@CapacitorPlugin(name = "Midi")
public class MidiPlugin extends Plugin {
    private MidiManager manager;
    private final Map<Integer, MidiDevice> devices = new HashMap<>();
    private final Map<Integer, List<MidiOutputPort>> ports = new HashMap<>();
    private final Map<Integer, String> names = new HashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        Context ctx = getContext();
        if (!ctx.getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) return;
        manager = (MidiManager) ctx.getSystemService(Context.MIDI_SERVICE);
        if (manager == null) return;
        manager.registerDeviceCallback(new MidiManager.DeviceCallback() {
            @Override
            public void onDeviceAdded(MidiDeviceInfo info) { openDevice(info); }

            @Override
            public void onDeviceRemoved(MidiDeviceInfo info) {
                closeDevice(info.getId());
                notifyDevices();
            }
        }, main);
        for (MidiDeviceInfo info : manager.getDevices()) openDevice(info);
    }

    @PluginMethod
    public void getDevices(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", manager != null);
        ret.put("names", namesArray());
        call.resolve(ret);
    }

    private JSArray namesArray() {
        JSArray arr = new JSArray();
        for (String n : names.values()) arr.put(n);
        return arr;
    }

    private void notifyDevices() {
        JSObject o = new JSObject();
        o.put("names", namesArray());
        notifyListeners("devices", o, true);
    }

    private void openDevice(MidiDeviceInfo info) {
        // un « port de sortie » de l'appareil = les notes qu'il nous envoie
        if (manager == null || info.getOutputPortCount() == 0 || devices.containsKey(info.getId())) return;
        manager.openDevice(info, device -> {
            if (device == null) return;
            int id = info.getId();
            devices.put(id, device);
            List<MidiOutputPort> list = new ArrayList<>();
            for (int i = 0; i < info.getOutputPortCount(); i++) {
                MidiOutputPort port = device.openOutputPort(i);
                if (port == null) continue;
                port.connect(new MidiReceiver() {
                    @Override
                    public void onSend(byte[] msg, int offset, int count, long timestamp) {
                        JSArray data = new JSArray();
                        for (int k = 0; k < count; k++) data.put(msg[offset + k] & 0xff);
                        JSObject o = new JSObject();
                        o.put("data", data);
                        notifyListeners("message", o);
                    }
                });
                list.add(port);
            }
            ports.put(id, list);
            Bundle props = info.getProperties();
            String name = props.getString(MidiDeviceInfo.PROPERTY_NAME);
            if (name == null || name.isEmpty()) name = props.getString(MidiDeviceInfo.PROPERTY_PRODUCT);
            if (name == null || name.isEmpty()) name = "Appareil MIDI";
            names.put(id, name);
            notifyDevices();
        }, main);
    }

    private void closeDevice(int id) {
        List<MidiOutputPort> list = ports.remove(id);
        if (list != null) for (MidiOutputPort p : list) {
            try { p.close(); } catch (IOException ignored) { }
        }
        MidiDevice d = devices.remove(id);
        if (d != null) {
            try { d.close(); } catch (IOException ignored) { }
        }
        names.remove(id);
    }

    @Override
    protected void handleOnDestroy() {
        for (Integer id : new ArrayList<>(devices.keySet())) closeDevice(id);
    }
}
