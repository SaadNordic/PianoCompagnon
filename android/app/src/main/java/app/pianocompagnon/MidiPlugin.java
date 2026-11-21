package app.pianocompagnon;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiInputPort;
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
 * Envoie aussi des notes au piano (méthode "send") : l'appli joue alors avec le vrai son du piano.
 */
@CapacitorPlugin(name = "Midi")
public class MidiPlugin extends Plugin {
    private MidiManager manager;
    private final Map<Integer, MidiDevice> devices = new HashMap<>();
    private final Map<Integer, List<MidiOutputPort>> ports = new HashMap<>();
    private final Map<Integer, String> names = new HashMap<>();
    private final Map<Integer, MidiInputPort> outs = new HashMap<>();
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
        ret.put("canPlay", !outs.isEmpty());
        call.resolve(ret);
    }

    /** Envoie des octets MIDI (note on/off, contrôleurs) à tous les pianos branchés. */
    @PluginMethod
    public void send(PluginCall call) {
        JSArray data = call.getArray("data");
        if (data == null || outs.isEmpty()) { call.resolve(); return; }
        byte[] bytes = new byte[data.length()];
        try {
            for (int i = 0; i < bytes.length; i++) bytes[i] = (byte) data.getInt(i);
        } catch (Exception e) { call.reject("données MIDI invalides"); return; }
        for (MidiInputPort port : outs.values()) {
            try { port.send(bytes, 0, bytes.length); } catch (IOException ignored) { }
        }
        call.resolve();
    }

    private JSArray namesArray() {
        JSArray arr = new JSArray();
        for (String n : names.values()) arr.put(n);
        return arr;
    }

    private void notifyDevices() {
        JSObject o = new JSObject();
        o.put("names", namesArray());
        o.put("canPlay", !outs.isEmpty());
        notifyListeners("devices", o, true);
    }

    private void openDevice(MidiDeviceInfo info) {
        // « port de sortie » de l'appareil = les notes qu'il nous envoie ; « port d'entrée » = ce qu'on lui fait jouer
        if (manager == null || (info.getOutputPortCount() == 0 && info.getInputPortCount() == 0) || devices.containsKey(info.getId())) return;
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
            if (info.getInputPortCount() > 0) {
                MidiInputPort in = device.openInputPort(0);
                if (in != null) outs.put(id, in);
            }
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
        MidiInputPort in = outs.remove(id);
        if (in != null) {
            try { in.close(); } catch (IOException ignored) { }
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
